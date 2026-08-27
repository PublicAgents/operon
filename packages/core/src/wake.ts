import type { RosterAgent } from "./roster.js";

/**
 * The wake environment contract: the scheduler assembles these variables,
 * the container entrypoint consumes them. One module owns the names so the
 * two sides cannot drift.
 */

export type WakeTrigger = "cron" | "manual";

/** Default hard wall per wake, minutes; roster maxWakeMinutes overrides. */
export const DEFAULT_MAX_WAKE_MINUTES = 120;

export interface WakeInit {
  wakeId: string;
  trigger: WakeTrigger;
  agent: RosterAgent;
}

export interface WakeSecrets {
  /** Short-lived token scoped to the agent's own state repo. */
  githubToken: string;
  /**
   * The mind credential for the agent's harness, e.g. a Claude subscription
   * OAuth token for claude-code. Injected under the variable name the
   * harness expects; the adapter owns that name.
   */
  mindCredential: string;
}

export interface WakeOptions {
  /** Telegram Gatekeeper notify endpoint; the entrypoint posts the end-of-wake summary here. */
  notifyUrl?: string;
  notifyToken?: string;
  /** Publish Gatekeeper endpoint; the porch submits site artifacts here. */
  publishUrl?: string;
  publishToken?: string;
  /** github Gatekeeper /commit endpoint + bearer; the entrypoint persists state here. */
  persistUrl?: string;
  persistToken?: string;
  /**
   * PR Gatekeeper endpoint and the INTERNAL bearer the porch authenticates
   * to it with. The GitHub machine credential lives only in that Worker,
   * never in this container. prRepos is the "owner/repo" allowlist.
   */
  prUrl?: string;
  prToken?: string;
  prRepos?: string;
  /** Email Gatekeeper endpoint + internal bearer (send/pull/reply). */
  emailUrl?: string;
  emailToken?: string;
  /** till Gatekeeper endpoint + this agent's OWN money bearer (per-agent). */
  tillUrl?: string;
  tillToken?: string;
  /** spend Gatekeeper endpoint + this agent's OWN money bearer (per-agent). */
  spendUrl?: string;
  spendToken?: string;
  /** vault Gatekeeper endpoint + this agent's OWN secret-store bearer (per-agent). */
  vaultUrl?: string;
  vaultToken?: string;
  /** Comma-separated literals the presleep verifier must not find in changed files. */
  secretDenylist?: string;
  /**
   * JSON array of extra CLI arguments appended to the harness session
   * invocation. Operator-owned deployment policy (e.g. the harness's
   * permission/autonomy settings); the chassis hardcodes none of it.
   */
  harnessExtraArgs?: string;
}

export const WAKE_ENV = {
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
  vaultToken: "OPERON_VAULT_TOKEN"
} as const;

export function wakeEnv(
  init: WakeInit,
  secrets: WakeSecrets,
  options: WakeOptions = {}
): Record<string, string> {
  const env: Record<string, string> = {
    [WAKE_ENV.wakeId]: init.wakeId,
    [WAKE_ENV.agentId]: init.agent.id,
    [WAKE_ENV.trigger]: init.trigger,
    [WAKE_ENV.stateRepo]: init.agent.stateRepo,
    [WAKE_ENV.harness]: init.agent.harness,
    [WAKE_ENV.model]: init.agent.model,
    [WAKE_ENV.githubToken]: secrets.githubToken,
    [WAKE_ENV.mindCredential]: secrets.mindCredential,
    [WAKE_ENV.maxWakeMinutes]: String(
      init.agent.maxWakeMinutes ?? DEFAULT_MAX_WAKE_MINUTES
    ),
    [WAKE_ENV.hosts]: init.agent.hosts.join(",")
  };
  if (init.agent.fallbackModel) env[WAKE_ENV.fallbackModel] = init.agent.fallbackModel;
  if (options.notifyUrl) env[WAKE_ENV.notifyUrl] = options.notifyUrl;
  if (options.notifyToken) env[WAKE_ENV.notifyToken] = options.notifyToken;
  if (options.publishUrl) env[WAKE_ENV.publishUrl] = options.publishUrl;
  if (options.publishToken) env[WAKE_ENV.publishToken] = options.publishToken;
  if (options.persistUrl) env[WAKE_ENV.persistUrl] = options.persistUrl;
  if (options.persistToken) env[WAKE_ENV.persistToken] = options.persistToken;
  if (options.prUrl) env[WAKE_ENV.prUrl] = options.prUrl;
  if (options.prToken) env[WAKE_ENV.prToken] = options.prToken;
  if (options.prRepos) env[WAKE_ENV.prRepos] = options.prRepos;
  if (options.emailUrl) env[WAKE_ENV.emailUrl] = options.emailUrl;
  if (options.emailToken) env[WAKE_ENV.emailToken] = options.emailToken;
  if (options.tillUrl) env[WAKE_ENV.tillUrl] = options.tillUrl;
  if (options.tillToken) env[WAKE_ENV.tillToken] = options.tillToken;
  if (options.spendUrl) env[WAKE_ENV.spendUrl] = options.spendUrl;
  if (options.spendToken) env[WAKE_ENV.spendToken] = options.spendToken;
  if (options.vaultUrl) env[WAKE_ENV.vaultUrl] = options.vaultUrl;
  if (options.vaultToken) env[WAKE_ENV.vaultToken] = options.vaultToken;
  if (options.secretDenylist) env[WAKE_ENV.secretDenylist] = options.secretDenylist;
  if (options.harnessExtraArgs) env[WAKE_ENV.harnessExtraArgs] = options.harnessExtraArgs;
  return env;
}

export type WakeStatus = "running" | "completed" | "failed";

export interface WakeRecord {
  wakeId: string;
  agentId: string;
  trigger: WakeTrigger;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  status: WakeStatus;
}
