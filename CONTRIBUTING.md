# Contributing to Operon

Operon is a chassis for autonomous agents that run unattended and hold
no credentials. That shapes every rule below: a change here runs
without a human watching, against a hostile internet, on behalf of an
operator who trusts the chassis more than the agent.

## Before you start

- Read `README.md` for the doctrine and `AGENTS.md` for the hard rules
  (the same rules bind human and AI contributors).
- Behaviour changes start in `specs/`. A pull request that changes what
  the chassis does without a spec change, or with a spec that
  contradicts the code, is not ready. Spec first, code that matches it,
  tests that pin it.
- One spec per design question; the existing ones are numbered in the
  order they were settled. A new spec takes the next number and names
  the specs it builds on.

## How the code is written

- Named refusals. A door or a validator that says no says why, with a
  stable name a test can assert (`repo_not_granted`, `checks_not_green`,
  `outcome_unknown`). Never coerce, never truncate silently.
- Fail closed and loudly. Missing configuration is a refusal, not a
  default. Paid or irreversible paths write a ledger row on every
  outcome, failure included.
- Pure functions for verdicts. Policy is a function of its evidence, in
  its own module, tested by name; handlers are thin and wire it.
- Zero dependencies unless argued. Every package in a Worker or the
  container is attack surface on a system that runs unattended.
  Justify additions in the pull request.
- Inbound content is data. Anything an agent reads must never be able
  to create or change policy, memory rules, or spending.
- Node 24, npm workspaces, nx, strict TypeScript, `nodenext` modules;
  `npx nx run-many -t lint build test typecheck` must pass.

## How prose is written

- No em dashes anywhere: prose, specs, commit messages, comments. Use
  commas, colons, parentheses, or separate sentences.
- No secrets, account ids, zone ids, or real operator identifiers in
  code, tests, fixtures, examples, or specs. The reference colony's
  values appear only where a doc says they are an example.
- No vendor names for services a colony chooses (proxy providers, model
  accounts): those belong in the colony's own repository.

## Commits and pull requests

- Conventional commit subjects: `feat(scheduler): ...`,
  `fix(gatekeepers/pr): ...`, `docs(specs): ...`. The body explains the
  problem and the rule, not the diff.
- No attribution trailers of any kind.
- One reviewable change per pull request. Large features land as an
  ordered series, each green on its own.
- Every pull request is reviewed by a second, independent model
  (Greptile) and merges at its top confidence score. Findings are
  fixed, not argued away; a finding that is wrong is answered with the
  code that proves it.
- A change to the container entrypoint or the presleep verifier needs
  one full wake run by hand against a scratch state repo, with the log
  read end to end, before it is called done.
- A change to a Gatekeeper tests the failure paths (denied, unapproved,
  the ledger write failing), not only the happy path.

## Licensing

Everything here is Apache-2.0 (see `LICENSE`). Contributions must be
original or Apache-2.0-compatible. Ideas from elsewhere can be
reimplemented; text and code cannot be imported from sources with
incompatible or unknown licences.
