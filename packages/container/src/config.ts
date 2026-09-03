/**
 * The container half of the wake environment contract. The names are
 * duplicated from @operon/core's WAKE_ENV on purpose: the Docker build
 * context is this package alone, so the entrypoint must be self-contained.
 * config.spec.ts imports the real WAKE_ENV and asserts the two sides match,
 * which turns drift into a red test instead of a broken wake.
 */

import { DEFAULT_EGRESS_ROUTES, parseBlocklist, parseEgressRoutes, type EgressRoutes } from "./egress-proxy.js";

export const ENV = {
  wakeId: "OPERON_WAKE_ID",
  agentId: "OPERON_AGENT_ID",
  trigger: "OPERON_TRIGGER",
  stateRepo: "OPERON_STATE_REPO",
  harness: "OPERON_HARNESS",
  model: "OPERON_MODEL",
  fallbackModel: "OPERON_FALLBACK_MODEL",
  githubToken: "OPERON_GITHUB_TOKEN",
  mindCredential: "OPERON_MIND_CREDENTIAL",
  notifyUrl: "OPERON_NOTIFY_URL",
  notifyToken: "OPERON_NOTIFY_TOKEN",
  secretDenylist: "OPERON_SECRET_DENYLIST",
  harnessExtraArgs: "OPERON_HARNESS_EXTRA_ARGS",
  maxWakeMinutes: "OPERON_MAX_WAKE_MINUTES",
  hosts: "OPERON_HOSTS",
  publishUrl: "OPERON_PUBLISH_URL",
  publishToken: "OPERON_PUBLISH_TOKEN",
  persistUrl: "OPERON_PERSIST_URL",
  persistToken: "OPERON_PERSIST_TOKEN",
  prUrl: "OPERON_PR_URL",
  prToken: "OPERON_PR_TOKEN",
  prRepos: "OPERON_PR_REPOS",
  emailUrl: "OPERON_EMAIL_URL",
  emailToken: "OPERON_EMAIL_TOKEN",
  tillUrl: "OPERON_TILL_URL",
  tillToken: "OPERON_TILL_TOKEN",
  spendUrl: "OPERON_SPEND_URL",
  spendToken: "OPERON_SPEND_TOKEN",
  vaultUrl: "OPERON_VAULT_URL",
  vaultToken: "OPERON_VAULT_TOKEN",
  asksUrl: "OPERON_ASKS_URL",
  asksToken: "OPERON_ASKS_TOKEN",
  mcpServers: "OPERON_MCP_SERVERS",
  mcpToken: "OPERON_MCP_TOKEN",
  githubGrants: "OPERON_GITHUB_GRANTS",
  disabledDoors: "OPERON_DISABLED_DOORS",
  localBrowser: "OPERON_LOCAL_BROWSER",
  chronicleUrl: "OPERON_CHRONICLE_URL",
  chronicleToken: "OPERON_CHRONICLE_TOKEN",
  xUrl: "OPERON_X_URL",
  xToken: "OPERON_X_TOKEN",
  webUrl: "OPERON_WEB_URL",
  webToken: "OPERON_WEB_TOKEN",
  egressProxy: "OPERON_EGRESS_PROXY",
  egressBlocklist: "OPERON_EGRESS_BLOCKLIST"
} as const;

export interface WakeConfig {
  wakeId: string;
  agentId: string;
  trigger: string;
  stateRepo: string;
  harness: string;
  model: string;
  fallbackModel?: string;
  githubToken: string;
  mindCredential: string;
  notifyUrl?: string;
  notifyToken?: string;
  secretDenylist: string[];
  /** Extra CLI arguments for the harness session, deployment policy (see wake contract). */
  harnessExtraArgs: string[];
  /** The wake's hard wall in minutes; the session gets this minus a margin. */
  maxWakeMinutes: number;
  /** Zone hosts this agent may publish to ("@" or subdomain labels). */
  hosts: string[];
  /** Publish Gatekeeper endpoint + bearer; absent means publishing is not wired. */
  publishUrl?: string;
  publishToken?: string;
  /** github Gatekeeper /commit endpoint + bearer for state persistence. */
  persistUrl?: string;
  persistToken?: string;
  /** PR Gatekeeper endpoint + internal bearer; absent means the PR door is closed.
   * The GitHub credential lives in that Worker, never here. */
  prUrl?: string;
  prToken?: string;
  /** Allowlisted "owner/repo" PR targets. */
  prRepos: string[];
  /** Email Gatekeeper endpoint + bearer; absent means the email doors are closed. */
  emailUrl?: string;
  emailToken?: string;
  /** till Gatekeeper endpoint + this agent's own money bearer. */
  tillUrl?: string;
  tillToken?: string;
  /** spend Gatekeeper endpoint + this agent's own money bearer. */
  spendUrl?: string;
  spendToken?: string;
  /** vault Gatekeeper endpoint + this agent's own secret-store bearer. */
  vaultUrl?: string;
  vaultToken?: string;
  /** asks Gatekeeper endpoint + this agent's own decision-queue bearer. */
  asksUrl?: string;
  asksToken?: string;
  /** Staged MCP servers (spec 0008 §4): stdio defs, or a name plus virtual host. */
  mcpServers: StagedMcpServer[];
  /** The wake nonce the MCP doors carry; absent when none are granted. */
  mcpToken?: string;
  /**
   * This agent's GitHub grants (spec 0008 §6), or undefined when the
   * roster carries none. The difference is load-bearing: an EXPLICIT
   * empty grant means "nothing", while an ABSENT one means "fall back
   * to the fleet list", and conflating them would let the container
   * admit repos the Gatekeeper refuses.
   */
  githubGrants?: { pr: string[]; write: string[] };
  /** chronicle Gatekeeper endpoint + internal bearer: transcript shipping. */
  chronicleUrl?: string;
  chronicleToken?: string;
  /** X Gatekeeper endpoint + this agent's own posting bearer. */
  xUrl?: string;
  xToken?: string;
  /** Web door (spec 0004): the browser relay endpoint + per-wake nonce. */
  webUrl?: string;
  webToken?: string;
  /**
   * Upstream HTTP proxies for the session's outbound HTTP (spec 0004 §8):
   * a table of host pattern to proxy address or "direct", parsed and
   * validated here (egress-proxy.ts). Unset means {"*": "direct"}, under
   * which no forwarder runs. The entrypoint's forwarder holds the
   * addresses; the session sees a loopback address.
   */
  egressProxy: EgressRoutes;
  /** Host patterns the session may not reach (spec 0004 §8); the forwarder refuses them. */
  egressBlocklist: string[];
  /** Doors the operator closed for this wake (spec 0006 §7): named in the help, not merely unwired. */
  disabledDoors: string[];
  /** The local browser (spec 0004 §9): Chrome through the Playwright MCP server, staged when true. */
  localBrowser: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parsed at wake start like the table: a malformed blocklist fails the wake by name. */
function parseEgressBlocklist(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    return parseBlocklist(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`invalid_env: ${ENV.egressBlocklist} ${detail}`);
  }
}

/** Parsed at wake start: a malformed proxy table fails the wake, not the first request. */
function parseEgressProxy(raw: string | undefined): EgressRoutes {
  if (!raw) return DEFAULT_EGRESS_ROUTES;
  try {
    return parseEgressRoutes(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`invalid_env: ${ENV.egressProxy} ${detail}`);
  }
}

/** The closed-doors list, a JSON array of names; malformed is a config error like the rest. */
export function parseDisabledDoors(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`invalid_env: ${ENV.disabledDoors} must be a JSON array`);
  }
  if (!Array.isArray(parsed) || !parsed.every(entry => typeof entry === "string")) {
    throw new ConfigError(`invalid_env: ${ENV.disabledDoors} must be a JSON array of door names`);
  }
  return parsed as string[];
}

/**
 * What the scheduler staged for this wake (spec 0008 §4): a stdio
 * definition to spawn, or a name whose only address is a virtual host
 * through the umbilical. The container never sees more.
 */
export type StagedMcpServer =
  | { name: string; type: "stdio"; command: string; args: string[] }
  | { name: string; type: "http"; virtual: string };

function parseMcpServers(raw: string | undefined): StagedMcpServer[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`invalid_env: ${ENV.mcpServers} must be a JSON array`);
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError(`invalid_env: ${ENV.mcpServers} must be a JSON array`);
  }
  for (const entry of parsed as Array<Record<string, unknown>>) {
    const ok =
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.name === "string" &&
      ((entry.type === "stdio" && typeof entry.command === "string" && Array.isArray(entry.args)) ||
        (entry.type === "http" && typeof entry.virtual === "string"));
    if (!ok) throw new ConfigError(`invalid_env: ${ENV.mcpServers} entry is malformed`);
  }
  return parsed as StagedMcpServer[];
}

function parseGithubGrants(
  raw: string | undefined
): { pr: string[]; write: string[] } | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`invalid_env: ${ENV.githubGrants} must be JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`invalid_env: ${ENV.githubGrants} must be a JSON object`);
  }
  const record = parsed as { pr?: unknown; write?: unknown };
  // Strict: a malformed grant must fail the wake, never quietly shrink
  // to fewer (or zero) repos than the policy the scheduler sent.
  const list = (value: unknown, key: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
      throw new ConfigError(`invalid_env: ${ENV.githubGrants}.${key} must be an array of strings`);
    }
    return value as string[];
  };
  return { pr: list(record.pr, "pr"), write: list(record.write, "write") };
}

type EnvSource = Record<string, string | undefined>;

function required(env: EnvSource, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`missing_env: ${name}`);
  return value;
}

function parseExtraArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      `invalid_env: ${ENV.harnessExtraArgs} must be a JSON array of strings`
    );
  }
  if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
    throw new ConfigError(
      `invalid_env: ${ENV.harnessExtraArgs} must be a JSON array of strings`
    );
  }
  return parsed as string[];
}

export function readWakeConfig(env: EnvSource): WakeConfig {
  const denylistRaw = env[ENV.secretDenylist] ?? "";
  return {
    wakeId: required(env, ENV.wakeId),
    agentId: required(env, ENV.agentId),
    trigger: required(env, ENV.trigger),
    stateRepo: required(env, ENV.stateRepo),
    harness: required(env, ENV.harness),
    model: required(env, ENV.model),
    fallbackModel: env[ENV.fallbackModel],
    githubToken: required(env, ENV.githubToken),
    mindCredential: required(env, ENV.mindCredential),
    notifyUrl: env[ENV.notifyUrl],
    notifyToken: env[ENV.notifyToken],
    secretDenylist: denylistRaw
      .split(",")
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0),
    harnessExtraArgs: parseExtraArgs(env[ENV.harnessExtraArgs]),
    maxWakeMinutes: parseMaxWakeMinutes(env[ENV.maxWakeMinutes]),
    hosts: (env[ENV.hosts] ?? "")
      .split(",")
      .map(host => host.trim())
      .filter(host => host.length > 0),
    publishUrl: env[ENV.publishUrl],
    publishToken: env[ENV.publishToken],
    persistUrl: env[ENV.persistUrl],
    persistToken: env[ENV.persistToken],
    prUrl: env[ENV.prUrl],
    prToken: env[ENV.prToken],
    prRepos: (env[ENV.prRepos] ?? "")
      .split(",")
      .map(repo => repo.trim())
      .filter(repo => repo.length > 0),
    emailUrl: env[ENV.emailUrl],
    emailToken: env[ENV.emailToken],
    tillUrl: env[ENV.tillUrl],
    tillToken: env[ENV.tillToken],
    spendUrl: env[ENV.spendUrl],
    spendToken: env[ENV.spendToken],
    vaultUrl: env[ENV.vaultUrl],
    vaultToken: env[ENV.vaultToken],
    asksUrl: env[ENV.asksUrl],
    asksToken: env[ENV.asksToken],
    mcpServers: parseMcpServers(env[ENV.mcpServers]),
    mcpToken: env[ENV.mcpToken],
    githubGrants: parseGithubGrants(env[ENV.githubGrants]),
    chronicleUrl: env[ENV.chronicleUrl],
    chronicleToken: env[ENV.chronicleToken],
    xUrl: env[ENV.xUrl],
    xToken: env[ENV.xToken],
    webUrl: env[ENV.webUrl],
    webToken: env[ENV.webToken],
    egressProxy: parseEgressProxy(env[ENV.egressProxy]),
    egressBlocklist: parseEgressBlocklist(env[ENV.egressBlocklist]),
    disabledDoors: parseDisabledDoors(env[ENV.disabledDoors]),
    localBrowser: env[ENV.localBrowser] === "1"
  };
}

const DEFAULT_MAX_WAKE_MINUTES = 120;

function parseMaxWakeMinutes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_WAKE_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(
      `invalid_env: ${ENV.maxWakeMinutes} must be a positive integer (minutes)`
    );
  }
  return value;
}
