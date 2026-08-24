import type { RosterAgent } from "./roster.js";

/**
 * The wake environment contract: the scheduler assembles these variables,
 * the container entrypoint consumes them. One module owns the names so the
 * two sides cannot drift.
 */

export type WakeTrigger = "cron" | "manual";

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
  harnessExtraArgs: "OPERON_HARNESS_EXTRA_ARGS"
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
    [WAKE_ENV.mindCredential]: secrets.mindCredential
  };
  if (init.agent.fallbackModel) env[WAKE_ENV.fallbackModel] = init.agent.fallbackModel;
  if (options.notifyUrl) env[WAKE_ENV.notifyUrl] = options.notifyUrl;
  if (options.notifyToken) env[WAKE_ENV.notifyToken] = options.notifyToken;
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
