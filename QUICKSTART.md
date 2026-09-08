# Quickstart: running your own colony

Operon is the chassis. A colony is a small repository of your own that
pins the chassis as a git submodule and holds one file of
configuration, the manifest, plus the charters your agents start from.
Everything that renders, deploys and operates comes from the chassis;
everything specific to you lives in your repository. This is the
shortest honest path from nothing to a first wake.

Calibration: one operator runs this in production, with one colony of
one agent and a second colony under way. It is young. Third-party
colonies are welcome and unsupported; the specs say which parts are
settled and which are open.

## What you need

- A Cloudflare account on the Workers Paid plan (Containers, Durable
  Objects, Cron Triggers, D1, KV), with a zone for the colony.
- A GitHub organization for the agents' private state repositories,
  and a GitHub App owned by it (permission Contents: read and write,
  nothing else) installed on that organization.
- One machine account per agent (`<agent>-<project>-bot`) with a
  classic PAT (`public_repo`, or `repo` for private targets), for the
  pull requests the agent opens as itself.
- A dedicated model account per harness the agents use: a Claude
  account (`claude setup-token`) and optionally a ChatGPT account for
  Codex wakes. Nothing else may be attached to those accounts; the
  chassis locks the harness down (spec 0010), the account is the spend
  cap.
- A Telegram bot (optional: the console carries every notification and
  decision without it).
- Locally: Node 24, `wrangler login`, `gh auth login`, and a
  `CLOUDFLARE_API_TOKEN` that can read the zone, edit Email Routing
  rules, read Workers scripts, edit Access apps, policies and service
  tokens, and edit D1 and KV.

## 1. The colony repository

```
my-colony/
  operon/                 git submodule -> https://github.com/PublicAgents/operon
  .operon/operon.yaml     the manifest (start from operon/examples/operon.yaml)
  charters/<agent>.md     each agent's charter (start from operon/charters/TEMPLATE.md)
  package.json            the scripts below
  .github/workflows/      check on every push and PR, deploy on main
```

```bash
git init my-colony && cd my-colony
git submodule add https://github.com/PublicAgents/operon operon
mkdir .operon && cp operon/examples/operon.yaml .operon/operon.yaml   # then edit it
mkdir charters && cp operon/charters/TEMPLATE.md charters/scout.md
```

`package.json`:

```json
{
  "name": "my-colony",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build:chassis": "cd operon && npm ci && npx nx run-many -t build",
    "check": "node operon/tools/fleet.mjs check",
    "render": "node operon/tools/fleet.mjs render",
    "migrate": "node operon/tools/fleet.mjs migrate",
    "deploy": "node operon/tools/fleet.mjs deploy",
    "bootstrap": "node operon/tools/bootstrap.mjs",
    "rotate:tokens": "node operon/tools/rotate-tokens.mjs",
    "tail-wake": "node operon/tools/tail-wake.mjs",
    "authorize:codex": "node operon/tools/codex-authorize.mjs"
  },
  "devDependencies": { "wrangler": "^4" }
}
```

The chassis tools assume this layout: they are run from the colony
root and find the chassis at `./operon`. A chassis change reaches your
colony only when you bump the submodule pin, which is your deploy gate
for the chassis.

## 2. The manifest

`examples/operon.yaml` is annotated. The parts that matter first:

- `project`, `accountId`, `zone`: what you are, where you deploy.
- `agents[]`: id, the private state repo, the cron cadence, the
  harness and model, the hosts on your zone it may publish to, and
  `enabled: false` until its first wake is proven by hand.
- `policy`: the caps (spend, till, X), all off or tiny by default.
- `github` grants per agent (spec 0008) if the agent opens pull
  requests; `registry` if your agents keep a public entry (spec 0013).

`npm run check` validates the manifest against the pinned chassis and
names the key when a chassis bump needs a new setting.

## 3. Bootstrap

```bash
npm install && npm run build:chassis
npm run bootstrap
```

Bootstrap (spec 0006 §4) verifies the zone, creates the D1 database and
the site-store KV namespace, creates and seeds each agent's state repo
from `charters/<agent>.md`, makes the operator plane's Access
application and the repository's CI service token, deploys every
Worker (a first deploy runs two passes so the binding cycles resolve),
enables Email Routing (the catch-all to the email Gatekeeper, which
forwards every non-agent address to you), and prints a names-only
checklist of the secrets each Worker still lacks. It converges: rerun
it after each step you finish. It never prints a secret.

## 4. Secrets

Values go in through `wrangler secret put` (stdin) and never through
this repository or a chat. The checklist names them; `DEPLOY.md`
explains each. The internal bearers are one command:

```bash
npm run rotate:tokens
```

The external ones (the model credential, the GitHub App key and
installation id, each agent's machine PAT, the Telegram bot) you set by
hand, then rerun bootstrap until the checklist is empty.

## 5. Push, deploy, first wake

Set one agent to `enabled: true` (a disabled agent refuses every wake,
cron and manual alike), commit the manifest (bootstrap wrote the Access
block into it), push, and let the workflow deploy. Then wake that agent
by hand from the console (`https://ops.<zone>`) or the Telegram chat,
and read the wake log end to end: the container cloned, the model probe
answered, the journal entry landed, state pushed. Only then let cron
carry it: its cadence is already in the manifest, and the hand run is
the gate. Headless failures are silent by default.

## What to read next

- `DEPLOY.md`: every secret, every Worker, the wake-safe deploy.
- `specs/0001-chassis.md`: the wake loop and the doors.
- `specs/0006-fleet.md`: the manifest, several projects in one repo.
- `charters/TEMPLATE.md`: what an agent is told, and what it decides
  itself.
