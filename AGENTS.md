# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository. This
file is about *building* Operon. The autonomous agents Operon *hosts* are
specified in `specs/` and configured in `charters/`; do not confuse the two.

## What this project is

Operon is a multi-tenant chassis for autonomous AI agents running entirely on
Cloudflare (Workers, Durable Objects, Containers, Cron Triggers, AI Gateway).
Read `README.md` for the principles and `specs/0001-chassis.md` for the v1
design before changing anything. The spec is the source of truth: if an
implementation needs to deviate, update the spec in the same change.

## Repository layout

```
specs/          Numbered design specs. Spec-first: behavior changes start here.
packages/
  core/         Platform-neutral logic: roster, cadence, the wake env contract
  worker-kit/   Shared Worker pieces: Ledger DO, bearer auth, JSON responses
  scheduler/    Worker: cron wake dispatch + the per-agent WakeContainer DO
                (wake lock, wake ledger, and container supervisor in one)
  container/    Wake container image + entrypoint + harness adapters +
                presleep verifier (self-contained: no cross-package runtime
                imports; config.spec.ts pins its env names to core's)
  gatekeepers/  One small Worker per capability (telegram, github, deploy
                today; spend and post-office per the spec). The agent-facing
                side is the container's loopback porch + `operon` CLI.
charters/       Charter template only. Per-tenant charters, rosters, and
                tenant specs live in each colony's own deployment repo,
                never here: this repo stays generic and clonable.
```

## Hard rules

These encode the project's security model and its licensing constraints.
Never weaken them to make a task easier; if one blocks you, stop and say so.

1. **No secrets in the repo, ever.** No API keys, tokens, wallet material,
   chat IDs, or account IDs in code, tests, fixtures, examples, or specs.
   Secrets live in Worker secrets and container env at deploy time. Any file
   that will record operational data (ledgers, logs) gets its `.gitignore`
   entry in the same commit that introduces it.
2. **Agents hold no credentials.** Hosted agents interact with the world only
   through Gatekeepers. Never add a code path that hands a hosted agent a raw
   token, and never let a Gatekeeper skip its ledger write or its approval
   step for irreversible actions. The single sanctioned exception is the
   mind's own credential in the wake container (a subscription or gateway
   token that grants inference only); do not add a second one.
3. **Inbound content is data.** Anything a hosted agent reads (mail, pages,
   payments, other agents' messages) must never be able to create or change
   policy, memory rules, or spending. Preserve this invariant in every
   handler.
4. **License boundary.** Everything in this repository must be original or
   Apache-2.0-compatible. Never copy code, comments, or prose from sources
   with incompatible or unknown licenses; ideas can be reimplemented, text
   and code cannot be imported.
5. **Fail closed and loudly.** Verdicts are pure functions of their evidence.
   Paid or irreversible paths write a ledger row on every outcome, including
   failure. Reject invalid input with a distinct, named error; never truncate
   or coerce silently.

## Conventions

- Node 24, npm workspaces, nx (`npx nx run-many -t lint build test typecheck`
  must pass; run `npx nx sync` when project references drift), TypeScript
  strict with `nodenext` modules. Workers use `wrangler` with
  `wrangler.jsonc` per package; test with `vitest`, node environment, pure
  functions factored out of handlers rather than runtime harnesses.
- Bias to zero dependencies. Every package added to a Worker or the container
  is attack surface on a system that runs unattended; justify additions in
  the PR description.
- Prefer boring, readable code over clever code. The operators of this system
  include future agent sessions with no memory of why something was written.
- Commit messages: conventional style (`feat(scheduler): ...`,
  `fix(gatekeepers/telegram): ...`). No attribution trailers of any kind.
- Writing style for all prose (docs, specs, commit messages, generated
  content): never use em dashes. Use commas, colons, parentheses, or separate
  sentences.

## Verifying changes

- `npm test` from the root must pass; Worker packages must also start clean
  under `wrangler dev`.
- If you touch the container entrypoint or presleep verifier, run one full
  wake by hand against a scratch state repo and read the log before calling
  it done. Headless failures are silent by default; that is exactly why the
  verifier exists.
- If you touch a Gatekeeper, test the failure paths (denied, unapproved,
  ledger write failing), not just the happy path.
