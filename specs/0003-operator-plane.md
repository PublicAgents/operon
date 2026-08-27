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
- **Container-facing, stays public HTTPS**: wake containers egress over
  the public internet, so the agent doors keep per-agent bearers. This
  is the designed containment: a leaked bearer is one agent's capped,
  held, ledgered doors, and rotation is one command with CI-enforced
  coverage. No change.
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

## 4. Operator tooling auth

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

## 5. Worker-to-worker: bindings, not bearers (operon#14)

Telegram reaches email and spend for approve/reject via service
bindings; the scheduler already reaches github that way. The shared
service tokens then bind only container-to-Worker calls (which cannot
use bindings), and every such caller is the entrypoint, never the mind.
Additionally: Telegram renders ACTION BUTTONS only for notifies that
arrive over a service binding; bearer-authenticated notifies (from
containers) render as plain text. A forged notify can then annoy, but
never carry an approve button.

## 6. Blast radius, after

| Leaked | Attacker gets |
| --- | --- |
| OPERATOR_API_TOKEN | nothing; it no longer exists |
| A per-agent door bearer | one agent's capped/held/ledgered doors until one rotate command |
| NOTIFY_TOKEN | text-only notify spam; no buttons, no decisions |
| Access service token | named, scoped, dashboard-revocable, Access-logged |
| Operator SSO session | requires the identity provider + device; revoke at the IdP |

## 7. Order of work

1. operon#14 service bindings + button-gating (removes shared-token
   exposure between Workers; small).
2. gatekeeper-ops + worker-kit Access-JWT verification + Access app
   (the gateway, reads first, then decisions).
3. Strip per-Gatekeeper operator endpoints + delete OPERATOR_API_TOKEN.
4. Tooling: tail-wake via Access token + `--wrangler` fallback mode.
5. Console UI on the gateway (separate effort; the data layer and auth
   are then already done).

## 8. Open decisions

1. Access identity provider (one-time dashboard choice; any works).
2. Whether /wake and /disable require a second factor beyond Access
   (e.g. confirm via Telegram) or Access device posture suffices.
3. Ops-gateway rate limits (Access already throttles, but the money
   decision endpoints deserve their own modest caps).
