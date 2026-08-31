/**
 * The container half of the wake environment contract. The names are
 * duplicated from @operon/core's WAKE_ENV on purpose: the Docker build
 * context is this package alone, so the entrypoint must be self-contained.
 * config.spec.ts imports the real WAKE_ENV and asserts the two sides match,
 * which turns drift into a red test instead of a broken wake.
 */

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
  chronicleUrl: "OPERON_CHRONICLE_URL",
  chronicleToken: "OPERON_CHRONICLE_TOKEN",
  xUrl: "OPERON_X_URL",
  xToken: "OPERON_X_TOKEN",
  webUrl: "OPERON_WEB_URL",
  webToken: "OPERON_WEB_TOKEN"
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
  /** chronicle Gatekeeper endpoint + internal bearer: transcript shipping. */
  chronicleUrl?: string;
  chronicleToken?: string;
  /** X Gatekeeper endpoint + this agent's own posting bearer. */
  xUrl?: string;
  xToken?: string;
  /** Web door (spec 0004): the browser relay endpoint + per-wake nonce. */
  webUrl?: string;
  webToken?: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
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
    chronicleUrl: env[ENV.chronicleUrl],
    chronicleToken: env[ENV.chronicleToken],
    xUrl: env[ENV.xUrl],
    xToken: env[ENV.xToken],
    webUrl: env[ENV.webUrl],
    webToken: env[ENV.webToken]
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
