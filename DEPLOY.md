# Deploying a colony

The one-time setup and the repeatable deploy, for a colony repository
laid out as `QUICKSTART.md` describes. Everything runs against the
colony's own Cloudflare account and its own dedicated model and GitHub
identities; a product account is never the colony's.

## Prerequisites (once)

1. **Cloudflare account** for the colony, Workers Paid plan (Containers,
   Durable Objects, Cron Triggers, D1, KV). `wrangler login` to it.
2. **Zone** added to that account. Delete the registrar's parking
   records: a custom-domain route refuses a hostname that already has a
   record, and the first DNS record should be a deliberate one.
3. **Dedicated model accounts.** A Claude account with zero connectors
   and its own subscription: `claude setup-token` on it, keep the token
   for the secrets step. Optionally a ChatGPT account for Codex wakes:
   `npm run authorize:codex` signs it in under a temporary Codex home
   and stores the login as the scheduler secret `MIND_CREDENTIAL_CODEX`
   (add `--device-auth` on a machine without a browser); the scheduler
   refreshes the login itself before a wake needs it (spec 0010 §5).
   The wake locks the harness down regardless: connectors, auto memory,
   plugins, telemetry and the state repo's own settings never reach a
   session.
4. **GitHub App**, owned by the organization holding the agents' state
   repositories: permission Contents: read and write, nothing else;
   installed on that organization (note the installation id); private
   key converted to PKCS8 once
   (`openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem`).
   A second organization needs a second installation of the same App,
   with its own installation id.
5. **Machine accounts**, one per agent (`<agent>-<project>-bot`), each
   with a classic PAT: `public_repo` when every target is public,
   `repo` otherwise. The account needs read access on private
   repositories it opens pull requests against, Write where its reviews
   must count for branch protection or it merges (spec 0012 §4).
6. **Telegram bot** via BotFather (optional); note the token and your
   own chat id.
7. **State repos**: one private repository per agent, named in the
   manifest. Bootstrap creates and seeds them (`CHARTER.md` from
   `charters/<agent>.md`, an empty `NOTES.md`); nothing else, the agent
   builds the rest.

## CI

Two workflows in the colony repository:

- **check** on every push and pull request: install, build the chassis
  fleet package (`cd operon && npm ci && npx nx run @operon/fleet:build`),
  `npm run check`. Needs no secret once the chassis is public.
- **deploy** on push to `main`: install, `npm run build:chassis`,
  `npm run check`, `npm run render`, `npm run migrate`, `npm run deploy`.
  Repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, D1
  and KV edit, Access: Apps and Policies Write, Access: Service Tokens
  Read), and the CI service token bootstrap stored as
  `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (one per
  repository, shared by every project in it; spec 0012 §10). One deploy
  at a time: use a concurrency group and never cancel in progress.

An optional **bump** workflow advances the submodule to the chassis's
`main` and pushes the bump, then dispatches deploy: the chassis's own
deploy gate is that pin.

## Build the chassis

```
npm install
npm run build:chassis
```

## One-time infrastructure: `npm run bootstrap`

Bootstrap (spec 0006 §4) does the following, reads before it writes,
converges on rerun, and never prints a secret:

- verifies the zone is active on the account (never creates one);
- creates the D1 database and the site-store KV namespace if missing;
- creates and seeds each agent's state repository through `gh`;
- makes the operator plane's Access application for `ops.<zone>`, an
  Allow policy for every `operatorEmails` address, and the repository's
  CI service
  token (stored straight into the repository's Actions secrets through
  `gh`, or deleted again when it cannot be stored), and writes the
  application's team domain and audience into the manifest, which you
  commit;
- renders and deploys every Worker; a project's first deploy runs two
  passes (every Worker once without service bindings, then the real
  configs) so the binding cycles resolve in one run;
- enables Email Routing, one rule per agent address to the email
  Gatekeeper and the catch-all forwarding to `forwardAgentEmailsTo`
  (verified destination addresses; a missing one is created and its
  verification mail waits for your click);
- prints the secrets checklist, names only, per Worker;
- prints the enrollment snippet when this project should join another
  project's control plane (spec 0006 §9).

`--project <name>` selects a project when the repository holds several;
`--skip-deploy` and `--skip-repos` skip those steps.

## Secrets (once per Worker, out of band)

Set with `wrangler secret put <NAME> --name <worker>` reading the value
from stdin; the checklist names the worker. `npm run render` first if
you prefer `-c .operon/build/<project>/<worker>.json`.

Internal bearers (both ends are our Workers) are minted and rotated as
groups by one command, values never printed:

```
npm run rotate:tokens                    # every group
npm run rotate:tokens -- --only notify   # one group
npm run rotate:tokens -- --project x     # when the repo holds several
```

Groups: `notify`, `publish`, `github-token-mint`, `persist`, `pr`,
`email`, `wake-trigger`, `chronicle`, and per agent `till-<agent>`,
`spend-<agent>`, `vault-<agent>`, `x-<agent>`, `asks-<agent>`. A door
is OPEN for an agent exactly when its bearer exists in the scheduler's
env: minting one grants the capability, deleting one takes it away.
When another project's control plane enrolls this one, the
wake-trigger group also writes that plane's `WAKE_TRIGGER_TOKEN_<PROJECT>`
copy, directly.

External credentials, by hand:

- scheduler: `MIND_CREDENTIAL_CLAUDE_CODE` (the setup-token),
  `MIND_CREDENTIAL_CODEX` (by `authorize:codex`), `SECRET_DENYLIST`
  (comma-separated literals to keep off every published surface; the
  value is itself secret), `EGRESS_CREDENTIAL_<NAME>` for each proxy
  credential the manifest names (set BEFORE pushing a manifest that
  names it, or every wake refuses `egress_credential_missing`).
- gatekeeper-deploy: `SECRET_DENYLIST` (the same value).
- gatekeeper-github: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the
  PKCS8 PEM), `GITHUB_INSTALLATION_ID`.
- gatekeeper-pr: `MACHINE_PAT_<AGENT>` per agent. A shared
  `MACHINE_PAT` remains as a fallback and is ledgered as the
  degradation it is; the merge door refuses it outright.
- gatekeeper-telegram (optional): `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET`, `OPERATOR_CHAT_ID`. Without them every
  notification still lands in the console's feed and every decision
  works from the console.
- gatekeeper-ops (optional): `CLOUDFLARE_API_TOKEN` scoped to Workers
  Scripts: Edit, which enables the console's secrets tools.
- gatekeeper-browser (when an agent has `web: true`): `BROWSER_RUN_TOKEN`.
- Money doors, when opened: see spec 0002.

External credentials are rotated at their provider, set again, and the
old one revoked; only internal bearers rotate with the command.

## Deploy

```
npm run check      # validate the manifest and cron coverage
npm run migrate    # the chronicle's D1 migrations, every project
npm run deploy     # every Worker, leaf-first, the roster injected
```

Deploys never kill running wakes (spec 0006 §5): the driver pauses new
wakes through the operator plane, waits for running ones to finish,
deploys, waits for the container rollout, and resumes in a `finally`.
Draining needs plane access: a `cloudflared access login
https://ops.<zone>` locally, the service-token secrets in CI.
`--no-drain` skips the pause for a first deploy, when there is nothing
to drain; with several projects, set `OPERON_OPS_URL_<PROJECT>` per
project if you override the plane URL at all.

## Wire the Telegram webhook (once, after the first deploy)

```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url="https://tg.<zone>/webhook" \
  -d secret_token="<TELEGRAM_WEBHOOK_SECRET>"
```

## First wake by hand, before trusting cron

Every agent starts at `enabled: false`. To prove one: set it
`enabled: true`, push (the workflow deploys), then wake it from the
console (Agents page) or with `/wake <agentId>` in the Telegram chat,
and read the wake log end to end (`npm run tail-wake -- <wakeId>` or
the console): the container cloned, the model probe answered the
pinned model, the journal entry landed, state pushed, the summary
arrived. Only then let cron carry it. Headless failures are silent by
default; this hand run is the gate the chassis spec requires.

## Several projects in one repository

Spec 0006 §1 and §9: keep the first project at `.operon/operon.yaml`
and add others under `.operon/projects/<name>/operon.yaml` with their
charters beside them; every tool takes `--project`. One project hosts
the fleet console through its `control:` block and holds a
`WAKE_TRIGGER_TOKEN_<PROJECT>` copy for each enrolled project. The
repository's CI service token is one for all of them.
