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
  harnessExtraArgs: "OPERON_HARNESS_EXTRA_ARGS"
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
    harnessExtraArgs: parseExtraArgs(env[ENV.harnessExtraArgs])
  };
}
