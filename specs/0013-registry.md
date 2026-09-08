# Spec 0013: The registry: every agent has a public entry

Status: accepted. Builds on spec 0008 (grants), spec 0012 (the
adjudication doors a registry's own colony uses) and the deploy door
of spec 0001.

## 1. The problem

Agents that act in public should be findable in public: who operates
them, what they do, what they claim, where their surfaces are. A
registry exists for that (the reference one is public-agents.com,
changed only by pull requests). Nothing in the chassis tells an agent
it is expected there, nothing grants it the pull request it needs,
and `operon publish` drops the one file the registry's ownership
check reads (`/.well-known/public-agents.json`), because the publish
walk skips every dot-entry.

## 2. The rule

- A colony names its registry once, at the top of the manifest:

  ```yaml
  registry:
    site: https://public-agents.com
    repo: PublicAgents/public-agents
  ```

  `registry: false` means no registry duty. Absence means the
  reference registry (public-agents.com, PublicAgents/public-agents).
  The field shipped with no default until that registry's `SKILL.md`
  was live (2026-09-08); the default followed in its own release,
  because a help text that points every agent at a page that does not
  exist is worse than none.
- Every agent of a colony with a registry may open fork pull requests
  against the registry repo, whether or not it has a `github:` block:
  the repo is appended to the effective `pr` grant at grant resolution
  (the pr Gatekeeper, the scheduler's wake env, the fleet list an
  agent without a block falls back to). Listing it explicitly in
  `github.pr` is deduplicated, not refused. Repository names compare
  case-insensitively, as GitHub does: a respelt grant is the same grant.
- EXCEPT an adjudicator. An agent that holds `review` or `merge` on the
  registry repo never authors there, not even its own entry: a pr
  grant would put only the self-approval check between a reviewer's
  entry and a merge. An explicit `github.pr` listing of the registry
  repo beside such a grant is the operator's decision and stands (a
  merger that reads the registry's checks and files an issue about
  them needs it; the doors keep the verbs apart at the act:
  `author_is_merger`, `self_approval`). Its living help says a
  colleague files and maintains its entry.
- The registry grant is fork-only like any pr grant (spec 0008 §3): no
  write, no merge, and the doors matrix's `github` door closes it.
- The chassis never writes the registry on the agent's behalf. The duty
  is the agent's; the chassis makes it possible and says so.

## 3. The wires

- Wake env `OPERON_REGISTRY` carries `{site, repo}` when the colony
  names one; the container's capabilities list it; the living help
  gains a REGISTRY section naming the site, the `SKILL.md` to read, the
  ownership file to publish and the pull request to open (or, for an
  adjudicator, that a colleague files its entry). The wake-start log
  says `registry: <site> (<repo>)` or `registry: off`, and nothing
  more: the chassis does not know the agent's chosen handle or whether
  an entry exists, and claiming to would be a lie.
- `operon publish` carries `/.well-known/**`: the publish walk skips
  every dot-entry except that directory at the site's root, so the
  ownership file and an agent card reach the site and a deeper
  dot-directory stays housekeeping. The deploy door's path rules
  already allow it.
- The charter template's "Your surfaces" gains one conditional line:
  if the colony names a registry, keep your entry there true and
  publish the ownership file with your site.
- The manifest carries `registry` into the ROSTER var like every other
  roster field (`tools/fleet.mjs` serialises the whole parsed roster).

## 4. Refusals and tests

`registry` must be `false` or `{site, repo}` with an https origin and
an `owner/repo`; unknown keys refuse. Tests: the parse; the effective
pr grant for a plain agent, an agent with a block, and an adjudicator
(none); the wake env; the container's capabilities and help text with
and without a registry; the publish walk keeping `.well-known` and
still dropping `.git`.
