# Spec 0003: The operator plane

Status: draft. Builds on spec 0001 (invariant 4: "Operator identity is
the Telegram chat ID and Cloudflare Access identity, nothing else") and
spec 0002 (money invariants).

## 1. The problem

Operator authority today is one static bearer, OPERATOR_API_TOKEN,
accepted by every Gatekeeper's public route. It authorizes reads (every
ledger, every message body, every transcript) AND decisions (approve,
reject, reconcile). One leak compromises the whole oversight plane, and
a static bearer on public HTTPS is the easiest thing in the system to
leak: it lives in shell history risk, laptop files, and copy-paste.

Two lesser instances of the same shape: the shared worker-to-worker
service tokens (EMAIL_SERVICE_TOKEN and friends) ride public HTTPS
between OUR OWN Workers, and a leaked NOTIFY_TOKEN lets an attacker
forge operator notifications, including ones carrying approve buttons,
which is a social-engineering path to real money decisions.

## 2. Surface tiers (what is public on purpose)

- **World-facing, stays public**: site serving on agent hosts, the
  till's paid paths (buyers), inbound email (platform-delivered), and
  the Telegram webhook, the ONE public operator-control endpoint,
  already gated by secret header + exact chat id.
- **Container-facing, goes credential-free**: the umbilical (section 4).
- **Worker-to-worker, goes private**: service bindings (operon#14).
- **Operator-facing, gets identity**: this spec.

## 3. The operator gateway (ops.<zone>)

One new Worker, `gatekeeper-ops`, on one hostname, behind a Cloudflare
Access application. It is the ONLY operator surface:

- **Reads**: chronicle queries (events, messages, wakes, wake tail),
  every ledger, every outbox, held queues, channel transcript.
- **Writes**: channel send, approve/reject (email, spend), reconcile,
  enable/disable, wake.
- It reaches Gatekeepers through SERVICE BINDINGS, never bearers. The
  Gatekeepers' own public operator endpoints are then REMOVED, and
  OPERATOR_API_TOKEN ceases to exist.
- The future console UI is a static app served by this same Worker
  behind the same Access application: one hostname, one auth, one
  audit log. Auth is Cloudflare Access (SSO + device posture +
  short-lived JWTs + instant revocation), NOT a bespoke auth stack:
  the console has exactly one trust domain. Better Auth remains the
  pattern for multi-tenant products, which this is not.

**Verification**: the Worker validates the `Cf-Access-Jwt-Assertion`
JWT on every request against the team's public keys, pinned to the
Access application's audience tag (a worker-kit helper; env carries
team domain + aud). Route-level Access alone is not trusted: the JWT
check runs in-Worker so a routing mistake fails closed.

## 4. The umbilical: no credential ever enters the container

Cloudflare Containers support Outbound Workers: handlers on the
Container class intercept the container's outbound HTTP IN THE WORKERS
RUNTIME, on the same machine, outside the container sandbox, with full
access to env and service bindings (`outboundByHost` /
`outbound`, plus `enableInternet` / `allowedHosts` / `deniedHosts` for
egress control). That is the zero-trust boundary the doors were missing:

- The entrypoint calls doors at VIRTUAL hostnames (plain
  `http://<door>.operon.internal/...`). The traffic never leaves the
  machine; the outbound handler intercepts it before any network.
- The handler runs on the WakeContainer class, the per-agent
  supervisor, so it KNOWS which agent's container is calling. It asserts
  the agent identity itself and forwards via service bindings to the
  Gatekeepers. Identity stops being a bearer and becomes a fact of the
  supervisor: unforgeable by the mind, unphishable, unleakable.
- Every door token disappears from the wake environment: till, spend,
  vault, x, email, notify, publish, persist, pr, chronicle. A fully
  compromised container holds NOTHING to exfiltrate; it can call its own
  agent's doors (it always could; it IS the agent) and nothing else.
- `deniedHosts` blocks the Gatekeepers' real public hostnames from
  container egress, so the doors work ONLY through the supervised path,
  and the SSRF fence gains a platform-level layer.
- Gatekeepers keep accepting per-agent bearers during migration; once
  every caller is the umbilical, the container-door bearers are deleted
  and the rotation table shrinks again. The transcript shipper and
  inbox/DM pulls ride the same path.
- **Phase 2, the last two credentials**: the mind credential (intercept
  `api.anthropic.com` with `interceptHttps` + the Cloudflare CA trusted
  in the image, inject the auth header outside the sandbox, so the
  session runs with a placeholder) and the short-lived git clone token
  (inject on `github.com`). After that the container is credential-free
  in the strongest sense: nothing in env, nothing on disk, nothing in
  any process's memory that grants anything.

## 5. The hostile-mind boundary (prompt injection)

The umbilical removes credential THEFT; it cannot remove the confused
deputy: a mind steered by malicious content it read (a webpage, a mail,
a DM, a PR comment) wields the agent's own legitimate authority. No
network boundary fixes that, so the doors are the boundary, and they
already assume a hostile mind: own-hosts publishing, allowlisted PR
targets, first-contact and first-merchant holds, per-day caps, reply-only
DMs, disclosure-preserving profile edits, swept outbound content.

One addition hardens this specifically against single-wake hijack:
**per-wake sub-caps under the daily caps** on the outward doors (posts,
DMs, follows, emails, spend). Daily caps are sized for a day of work; a
hijacked wake can currently burn a day's budget in one burst. A per-wake
slice bounds the damage of one poisoned context to a fraction of a day,
and the next wake starts clean without the poisoned page in its context.
Sizing rule of thumb: half the daily cap or less per wake, tunable per
door via env beside the existing caps.

A second, distinct vector is BROWSER-ORIGIN calls: page JS in a browser
the mind runs can fire cross-origin POSTs at in-container surfaces
without the mind's cooperation (blind CSRF). Two mechanical boundaries:
- The porch requires a custom header (x-operon-porch), which forces a
  CORS preflight the porch never approves; browser-origin calls die in
  the browser (#32, shipped).
- Post-umbilical, the virtual-hostname doors additionally require a
  per-wake nonce minted by the supervisor and held by the ROOT
  entrypoint only (never the session env): page JS AND raw in-session
  calls are then both refused, and every door call passes through the
  porch and its sweeps.

Also restated as doctrine: ambient door access inside the wake is BY
DESIGN for the MIND (through the porch), so no door may assume its
caller is "the real mind"; every door defends itself.

## 6. Operator tooling auth

- **Interactive CLI** (tail-wake, future ops commands): a cached
  short-lived token from `cloudflared access token` (browser SSO once,
  then silent refresh); the tool sends it as the Access JWT header.
- **Fallback, zero chassis credentials**: `wrangler tail` for live logs
  and `wrangler d1 execute operon-chronicle --remote` for chronicle
  queries ride Cloudflare API auth and keep working with no colony
  token at all; tail-wake grows a `--wrangler` mode using them.
- **rotate-tokens and deploys** already ride wrangler/Cloudflare auth;
  no change.
- Access **service tokens** (client id/secret pairs) are permitted for
  unattended automation only, scoped to the ops app, named per use, and
  revocable in the dashboard; never for interactive use.

## 7. Worker-to-worker: bindings, not bearers (operon#14)

Telegram reaches email and spend for approve/reject via service
bindings; the scheduler already reaches github that way. The shared
service tokens then bind only container-to-Worker calls (which cannot
use bindings), and every such caller is the entrypoint, never the mind.
Additionally: Telegram renders ACTION BUTTONS only for notifies that
arrive over a service binding; bearer-authenticated notifies (from
containers) render as plain text. A forged notify can then annoy, but
never carry an approve button.

## 8. Blast radius, after

| Leaked | Attacker gets |
| --- | --- |
| OPERATOR_API_TOKEN | nothing; it no longer exists |
| A container compromise | the agent's own capped/held/ledgered doors, which it had anyway; no credentials exist inside to steal |
| A per-agent door bearer (during migration only) | one agent's capped doors until one rotate command; deleted once the umbilical lands |
| NOTIFY_TOKEN | text-only notify spam; no buttons, no decisions |
| Access service token | named, scoped, dashboard-revocable, Access-logged |
| Operator SSO session | requires the identity provider + device; revoke at the IdP |

## 9. Order of work

1. operon#14 service bindings + button-gating (removes shared-token
   exposure between Workers; small).
2. gatekeeper-ops + worker-kit Access-JWT verification + Access app
   (the gateway, reads first, then decisions).
3. Strip per-Gatekeeper operator endpoints + delete OPERATOR_API_TOKEN.
4. The umbilical: outbound handlers on WakeContainer, virtual door
   hosts in the entrypoint, scheduler service bindings to every
   Gatekeeper, then delete the container-door bearers and their env
   plumbing.
5. Tooling: tail-wake via Access token + `--wrangler` fallback mode.
6. Console UI on the gateway (spec 0005: the console and the tool
   registry; the data layer and auth are then already done).
7. Phase 2 umbilical: mind credential + clone token interception
   (interceptHttps + image CA trust). The credential half is BUILT
   (feat/mind-credential-injection: per-harness host table in core,
   placeholder in the container env, WakeContainer attaches the
   interceptor, pure injectHeaders unit-tested); it lands with the CA
   trust + a canary wake.
8. Per-wake sub-caps on the outward doors (section 5).

## 10. Open decisions

1. Access identity provider — SETTLED 2026-08-27: One-time PIN (the
   built-in method; the operator's email is the policy). The verifier is
   IdP-agnostic, so adding GitHub SSO later is a dashboard-only change.
2. Whether /wake and /disable require a second factor beyond Access
   (e.g. confirm via Telegram) or Access device posture suffices.
3. Ops-gateway rate limits (Access already throttles, but the money
   decision endpoints deserve their own modest caps).
4. Whether container egress moves to an allowlist posture
   (`allowedHosts`) once the mind's legitimate destinations are
   understood, or stays open-with-denials (the mind's work needs the
   open web; a too-tight list starves it).
