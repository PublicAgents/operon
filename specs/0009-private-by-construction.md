# 0009: Private by construction

Status: accepted 2026-09-02. Implements the operator's ask that only the
wake container and the operator plane can reach a Gatekeeper.

## 1. The problem

Every Gatekeeper was born with a public hostname (`gh-gk.<zone>`,
`pr-gk.<zone>`, `email-gk.<zone>`, `spend-gk`, `vault-gk`,
`chronicle-gk`, `x-gk`, `asks-gk`) because the container once called
doors over HTTPS with a bearer. Since spec 0003 step 4 the container
reaches every door through the umbilical, which swaps the per-wake
nonce for the real bearer OUTSIDE the container and forwards over a
private service binding; and since spec 0003 step 3 the operator plane
reaches every Gatekeeper over binding-only `Ops` entrypoints. The
hostnames outlived their callers. A bearer still guards each of them,
but a guarded door on the public internet is a surface, and a surface
with no legitimate caller is a surface for nobody but an attacker.

The obvious answer, Cloudflare Access with service tokens in front of
each hostname, protects nothing the binding path does not already
protect, adds a credential every caller must hold and rotate, and
cannot cover the surfaces that genuinely must stay public (Telegram's
webhook, the published sites, the till's storefront). So the answer is
the one this chassis already lives by: **the binding IS the
authorization.** A Worker that serves only bindings has no hostname. A
Worker that must have a hostname serves the public exactly what the
public needs, and everything internal lives on entrypoints that only a
binding can reach.

## 2. The rule

- **No hostname without a public purpose.** A Gatekeeper gets a route
  only if someone outside our Workers must reach it: Telegram's
  webhook (`tg.<zone>`), the published sites and the storefront
  (the zone apex and the agents' hosts), the operator plane
  (`ops.<zone>`). Everything else renders with no route at all.
- **A public hostname serves the public surface only.** On the three
  workers that keep one, the default export answers the public need
  (the webhook; GET/HEAD of a site; the storefront) and nothing else.
  Door paths move to a `Door` entrypoint (`WorkerEntrypoint`) that the
  umbilical reaches over a dedicated service binding with that
  entrypoint named (`TELEGRAM_DOOR`, `DEPLOY_DOOR`, `TILL_DOOR`), the
  way the plane reaches `Ops`. A public request can no longer address
  a door at all, bearer or no bearer.
- **Our Workers notify over the binding, never over a URL.** The
  scheduler, its container supervisor, and every Gatekeeper that
  alerts the operator call the telegram Gatekeeper's `notify`
  entrypoint over a `TELEGRAM` binding (the only path that may carry
  decision buttons, spec 0003 §7). `NOTIFY_URL` disappears from every
  worker's vars, and `NOTIFY_TOKEN` remains only where the umbilical's
  notify door needs a bearer: the telegram `Door` and the scheduler
  that presents it. The notify rotation group shrinks to those two.
- **The scheduler carries no door URLs.** `PERSIST_URL`, `PR_URL`,
  `EMAIL_URL`, `TILL_URL`, `SPEND_URL`, `VAULT_URL`, `CHRONICLE_URL`,
  `X_URL`, `ASKS_URL`, `PUBLISH_URL` were shadowed by the umbilical's
  virtual hosts at every launch and are gone.

## 3. The one Access surface, made by the tools

The operator plane is the only surface guarded by Cloudflare Access:
people sign in, CI presents a service token. That application was made
by hand and its AUD pasted into the manifest. Now the tools own it:

- **Bootstrap** (spec 0006 §4) ensures the Zero Trust organization is
  known (its team domain), that a self-hosted Access application exists
  for `ops.<zone>` with an Allow policy for every address in
  `operatorEmails` (sign-ins; agent mail goes to `forwardAgentEmailsTo`
  instead) and a
  Service Auth policy for the repository's CI service token, named
  `operon-ci-<owner>-<repo>` (one token per repository, shared by every
  project the repository deploys; spec 0012 §10 explains why a
  per-project name overwrote the first project's token and how a
  legacy `operon-<project>-ci` token is renamed in place),
  creates the token when it is missing and writes its id and secret
  straight into the repository's GitHub Actions secrets
  (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) through `gh`,
  never printing either, and writes the application's AUD and the team
  domain back into the manifest's `access:` block. Without `gh`, the
  token is deleted again rather than left dangling, and bootstrap says
  which secrets to make by hand.
- **Deploy** reconciles the application and its policies on every run
  (idempotent: read, compare, fix only what drifted), and reports a
  missing service token as a `needs you` line rather than minting one
  (CI cannot write its own repository secrets). Without an API token
  that can edit Access, deploy says so once and continues; the plane
  itself fails closed (`access_unconfigured`) when its vars are empty.
- The manifest's `access:` block becomes optional: absent until
  bootstrap fills it, refused as before when malformed.
- The CI token therefore carries, beyond Workers Scripts:Edit and the
  D1 and KV permissions, `Access: Apps and Policies Write` and
  `Access: Service Tokens Read`. `Access: Service Tokens Write` is
  needed only where bootstrap runs, and `Access: Organizations,
  Identity Providers, and Groups Read` only where the manifest has no
  `access.teamDomain` yet (bootstrap reads the organization once and
  writes the domain into the manifest; deploy reads it from there).

## 4. What does not change

- Every real bearer stays where it was (a Gatekeeper's secrets are
  untouched); only the doors that presented them over the public
  internet close. A misconfigured binding fails with
  `binding_unwired:<NAME>`, as today.
- The umbilical's door table names the same doors with the same
  bearers; three of them point at `Door` entrypoints instead of
  default exports.
- The telegram webhook keeps its secret; the published sites and the
  storefront stay public by nature.

## 5. Verification

- Templates: the eight Gatekeepers render no `routes`; the scheduler
  renders `TELEGRAM_DOOR`, `DEPLOY_DOOR`, `TILL_DOOR` bindings with
  entrypoints and none of the retired URL vars; vault, x and asks
  render a `TELEGRAM` binding.
- The umbilical door table resolves notify, publish and till to the
  entrypoint bindings.
- The rotation coverage spec still finds every accepted bearer covered
  after the notify group shrinks.
- Live, after the deploy: the retired hostnames answer nothing (their
  custom-domain records are removed with the routes); a public POST to
  `tg.<zone>/notify` or `<zone>/gatekeeper/publish` is a 404; a
  hand-run wake still notifies, publishes and sells through the
  umbilical; the plane's `fleet_projects` still answers behind Access.
- Bootstrap against a project whose manifest has no `access:` block
  creates the application, the policies and the token, and fills the
  block.
