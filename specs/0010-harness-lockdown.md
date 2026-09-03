# 0010: The harness sees only what the chassis stages; one agent, many harnesses

Status: accepted 2026-09-03. Implements the operator's two asks: a mind
session must use only the capabilities the chassis hands it, never a
connector, memory, plugin, or setting attached to the provider account
it signs in with; and one agent must be wakeable on a different harness
(Codex CLI next to Claude Code) as the same agent, with the same memory,
doors, and grants.

## 1. The problem

A headless harness signs in with a dedicated provider account (spec
0001 §4.1). That account is a login, but the harness treats it as a
configuration source: Claude Code fetches the account's claude.ai
connectors as MCP servers, keeps an auto-memory directory it writes to
and reads from across sessions, syncs skills, and follows plugin
marketplaces; Codex CLI fetches the ChatGPT account's apps
(connectors), a remote plugin catalog, and tool suggestions. None of
that passed through a Gatekeeper, a grant, or the doors matrix. A
connector the operator attached to the account for another purpose
would appear in the mind's toolbox with the account's credential behind
it, outside the ledger, and outside `operon --help`.

The mind's working tree is a second configuration source: both
harnesses read project-level settings, hooks, MCP servers, rules, and
skills from the directory they run in. The state repo is written by the
mind, so anything it puts under `.claude/` or `.codex/` would be config
the chassis never reviewed. Most of it runs as the mind and escalates
nothing, but a project `env` block can redirect the harness's own API
endpoint, which would send the mind credential wherever the file says.

Finally, the second harness. Spec 0001 lists `codex` as the second
adapter and stubs it with a named error. An agent is one roster entry
with one `harness`; running the same agent on another harness meant a
second agent, a second state repo, and a second identity, which is the
opposite of "the same agent".

## 2. The rule

- **The chassis is the only configuration source for a session.** Every
  file a harness reads at start is written by the entrypoint for this
  wake, under the mind's home, from the wake's environment: settings,
  hooks, the MCP config, the credential. Nothing carries over between
  wakes and nothing is read from the working tree.
- **Account-attached features are off, in every layer that can say so.**
  The session environment carries the harness's off switches; the staged
  user settings repeat them; and for Claude Code a managed settings file
  baked into the image (root-owned, unwritable by the mind) repeats them
  a third time, so a mind that edits its own user settings mid-session
  cannot turn a connector back on.
- **The working tree is data, not configuration.** Claude Code runs with
  `--setting-sources user` and `--strict-mcp-config`: project settings,
  project hooks, project rules, and project `.mcp.json` do not load. Codex
  never has the state directory listed as a trusted project, so its
  `.codex/config.toml`, hooks, and rules stay disabled by Codex's own
  trust rule. The mind's memory is its repository, read through the wake
  prompt and its own file reads, the same on every harness.
- **A harness's capabilities come from the adapter, not the operator's
  extra args.** The lockdown flags are chassis invariants the adapter
  emits on every session and probe. `HARNESS_EXTRA_ARGS` stays what it
  was: the operator's autonomy policy (permission mode, output format),
  now per harness.
- **One agent, many harnesses.** A roster entry keeps its primary
  `harness`/`model` and may name alternates under `harnesses:` with a
  model pin each. A manual wake may name one of them; the wake runs the
  same agent (same state repo, doors, grants, per-agent bearers) on that
  harness. Cron wakes use the primary. The record of a wake carries the
  harness it ran on.

## 3. Claude Code

Staged per wake under `/home/mind/.claude/settings.json` (mind-owned,
rewritten every wake):

```json
{
  "autoMemoryEnabled": false,
  "disableClaudeAiConnectors": true,
  "hooks": { "PostToolUse": [...pull hook...], "Stop": [...journal guard...] }
}
```

Baked into the image at `/etc/claude-code/managed-settings.json`
(root-owned; managed settings outrank every other file and the mind
cannot write there):

```json
{
  "disableClaudeAiConnectors": true,
  "autoMemoryEnabled": false,
  "strictKnownMarketplaces": true,
  "env": { ...the same off switches as below... }
}
```

The session and probe environment, emitted by the adapter:

| Variable | Value | Turns off |
| --- | --- | --- |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | `false` | claude.ai connectors as MCP servers |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | auto memory (read and write) |
| `DISABLE_AUTOUPDATER` | `1` | self-update (the image pins the version) |
| `DISABLE_TELEMETRY` | `1` | usage telemetry |
| `DISABLE_ERROR_REPORTING` | `1` | crash reports |
| `DISABLE_BUG_COMMAND` | `1` | the feedback command |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | everything above plus version checks and cost warnings |

Session flags the adapter always emits: `--setting-sources user`,
`--strict-mcp-config`, and `--mcp-config <staged file>` when the wake
has MCP servers. Spec 0008 §6 chose non-strict MCP so a state repo's
own `.mcp.json` would load; this spec reverses that: a server the mind
declares for itself is a capability the chassis did not give it.

## 4. Codex CLI

The second adapter, as spec 0001 decision 1a ordered. Codex keeps its
home in `CODEX_HOME=/home/mind/.codex`, created per wake and staged with:

- `config.toml`: the model pin, `cli_auth_credentials_store = "file"`,
  `approval_policy = "never"`, `check_for_update_on_startup = false`,
  `[history] persistence = "none"`, `[analytics] enabled = false`,
  `[feedback] enabled = false`, `[otel]` exporters `"none"` with
  `log_user_prompt = false`, `[features]` with `apps`, `plugins`,
  `remote_plugin`, `tool_suggest`, `recommended_plugins`, `memories`,
  `browser_use`, `computer_use`, and `in_app_updates` all `false`, and
  the wake's MCP servers as `[mcp_servers.<name>]` tables (`command` and
  `args` for stdio; `url` and `http_headers` carrying the wake nonce for
  the umbilical's virtual hosts). No `[projects]` entry: the state
  directory is untrusted, so its own config, hooks, and rules stay off.
- `hooks.json`: the same PostToolUse pull hook and Stop journal guard,
  which Codex runs with the same stdin fields (`stop_hook_active`) and
  the same stdout envelopes (`hookSpecificOutput.additionalContext`,
  `decision: "block"`). Staged hooks are not "trusted" in Codex's sense
  (trust is granted in its TUI), so the session runs with
  `--dangerously-bypass-hook-trust`; the hooks are the chassis's own.
- `auth.json`: the mind credential (§5).

The session is `codex exec <prompt> -m <model> --skip-git-repo-check
--ephemeral --color never` in the state directory, plus the staged
`--dangerously-bypass-hook-trust` and the operator's extra args; the probe runs the same with `--sandbox read-only`. Codex
has no fallback-model flag: the entrypoint's probe-then-fallback covers
an unavailable pinned model before the session; mid-session fallback is
a Claude Code feature only.

Known residuals, named rather than hidden: with ChatGPT auth Codex
loads a workspace-managed configuration bundle from the account at
startup (no documented opt-out); and Codex's built-in web search stays
at the harness default, as Claude Code's built-in web tools do. Both
are provider-side features of inference itself, not connectors.

## 5. Credentials and the operator's policy, per harness

`MIND_CREDENTIAL_<HARNESS>` on the scheduler (spec 0001) holds what the
adapter needs to sign in:

- `claude-code`: the setup-token, injected as `CLAUDE_CODE_OAUTH_TOKEN`.
- `codex`: either the JSON of a `codex login` (`auth.json`: `auth_mode`,
  `tokens`, `last_refresh`), staged as `$CODEX_HOME/auth.json`, or an
  API key, injected as `CODEX_API_KEY`. The tool
  `tools/codex-authorize.mjs` runs `codex login` under a temporary home
  and pipes the result into the secret, never printing it. A Cloudflare
  secret holds at most 5 KB; a login file is about 4 KB.

The chassis denylists every literal inside a file credential (the
tokens, not only the file as a whole), so a JWT can never ride a
transcript or a commit.

**The refresh, done by the scheduler.** Codex refreshes a login file
in place when it is eight days old or rejected, and its refresh tokens
are single-use, so a copy in a secret goes stale after the first
refresh. The refresh must therefore happen where the credential is
held, not where it is used: a file the mind owns is a file the mind can
write, and nothing that comes back out of a container can be trusted
to rotate a credential every agent on that harness shares. So the
scheduler refreshes a Codex login itself at launch, one day before
Codex would (the same grant against the same public client and token
endpoint Codex uses), keeps the result in the FleetControl store keyed
by the fingerprint of the secret it descends from, and starts every
later wake from it while the operator's secret is unchanged (a new
`authorize:codex` is a new fingerprint and orphans the stored refresh).
A refusal by the authority while the access token is still valid lets
the wake run on what it has, named in the log; once the access token
has expired too, the wake is refused as
`mind_credential_refresh_failed`: the operator authorizes again, and
nothing the container could do would help. Inside the container a
rewrite of the login (a revoked token, the one case left) is noted in
the log, its tokens join the denylist before presleep, and it does not
carry over.

`HARNESS_EXTRA_ARGS` (the scheduler policy var) is the claude-code
policy; `HARNESS_EXTRA_ARGS_CODEX` is the codex policy, defaulting to
`["--dangerously-bypass-approvals-and-sandbox", "--json"]`: the
container is the sandbox, as `bypassPermissions` says for Claude Code,
and the JSONL event stream is the transcript.

## 6. The wake, the plane, the console

- `POST /wake/<agent>` on the scheduler takes an optional JSON body
  `{ "harness": "<id>" }`. An unknown harness is refused
  (`unknown_harness`), a known one the roster gave this agent no pin for
  is refused (`harness_not_configured`), and a missing credential for it
  is `mind_credential_missing` as before. The `wake` tool takes the same
  optional `harness`; `/agents` lists each agent's `harnesses` (primary
  first); the console's wake button offers the choice when there is
  one.
- The wake record and the chronicle's `wake_finished` row carry
  `harness`; the end-of-wake summary names it.
- The image carries both CLIs, pinned. Spec 0001 §4.1 said one image per
  harness; one image with every adapter's CLI is what makes a per-wake
  harness choice possible without a second container class, and the
  drain gate still hashes the one Dockerfile.

## 7. Verification

- Core: a roster naming an unknown `harness`, an alternate that repeats
  the primary, or a pin without a model is refused by name; the wake env
  carries the resolved mind, not the agent's primary.
- Scheduler: `resolveMind` picks primary, alternate, or refuses;
  `prepareLaunch` reads the per-harness extra args, prefers a stored
  refresh only when its seed fingerprint matches, refreshes a login that
  is due against a fake authority and stores the result, wakes on a
  still-valid login when the authority refuses, and refuses by name
  once the access token has expired too.
- Container: the adapters' staged files and environments are pure and
  tested (Claude Code: settings, managed keys, flags, env; Codex:
  config.toml, hooks.json, auth.json, env); the adapter table equals
  core's `KNOWN_HARNESSES`.
- Live (AGENTS.md rule: a container change needs one hand-run wake read
  end to end): a claude-code wake logs the lockdown, shows no claude.ai
  connectors in its MCP list, and still pulls, journals, and persists; a
  codex wake of the same agent reads the same repo, uses the umbilical
  doors, and journals with the stamp.
