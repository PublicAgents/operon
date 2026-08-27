import {
  wakeEnv,
  HARNESS_CREDENTIAL_INJECTION,
  INJECTED_CREDENTIAL_PLACEHOLDER,
  type RosterAgent,
  type WakeTrigger,
  type WakeSecrets,
  type WakeOptions
} from "@operon/core";

/**
 * Pure assembly of a wake launch: which secret variable a harness draws its
 * mind credential from, and the full container environment. Kept free of
 * bindings so it is testable without a Workers runtime.
 */

/** "claude-code" -> "MIND_CREDENTIAL_CLAUDE_CODE" */
export function mindCredentialVar(harness: string): string {
  return `MIND_CREDENTIAL_${harness.toUpperCase().replace(/-/g, "_")}`;
}

/** "promoter" -> "TILL_TOKEN_PROMOTER" (money bearers are per-agent). */
export function tillTokenVar(agentId: string): string {
  return `TILL_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

/** "promoter" -> "SPEND_TOKEN_PROMOTER" (money bearers are per-agent). */
export function spendTokenVar(agentId: string): string {
  return `SPEND_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

/** "promoter" -> "VAULT_TOKEN_PROMOTER" (secret-store bearers are per-agent). */
export function vaultTokenVar(agentId: string): string {
  return `VAULT_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

/** "promoter" -> "X_TOKEN_PROMOTER" (posting bearers are per-agent). */
export function xTokenVar(agentId: string): string {
  return `X_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

export class LaunchPreconditionError extends Error {
  override name = "LaunchPreconditionError";
  constructor(
    readonly code: string,
    detail: string
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface LaunchContext {
  /** Looks up a secret/var by name; backed by the Worker env at runtime. */
  getSecret(name: string): string | undefined;
  /** Mints a short-lived token scoped to the agent's state repo. */
  getGithubToken(agent: RosterAgent): Promise<string>;
  options: WakeOptions;
}

export interface PreparedLaunch {
  wakeId: string;
  agentId: string;
  trigger: WakeTrigger;
  env: Record<string, string>;
  /**
   * API hosts whose outbound HTTPS the WakeContainer injects the real
   * mind credential onto (spec 0003 phase 2). When set, the container's
   * OPERON_MIND_CREDENTIAL is the worthless placeholder; the real
   * credential is passed to the injector via the scheduler env, never
   * into the container. Empty = credential rides in the container env
   * (pre-injection behavior), still supported for harnesses without an
   * injection entry.
   */
  credentialInjectionHosts: string[];
}

export async function prepareLaunch(
  agent: RosterAgent,
  trigger: WakeTrigger,
  wakeId: string,
  context: LaunchContext
): Promise<PreparedLaunch> {
  const credentialVar = mindCredentialVar(agent.harness);
  const mindCredential = context.getSecret(credentialVar);
  if (!mindCredential) {
    throw new LaunchPreconditionError(
      "mind_credential_missing",
      `secret ${credentialVar} is not configured for harness "${agent.harness}"`
    );
  }

  const githubToken = await context.getGithubToken(agent);
  // Egress injection (spec 0003 phase 2): if this harness has an
  // injection entry, the container carries only a PLACEHOLDER credential
  // and the WakeContainer swaps in the real one at egress. The real
  // credential never enters the container env.
  const injection = HARNESS_CREDENTIAL_INJECTION[agent.harness];
  const credentialInjectionHosts = injection ? injection.hosts : [];
  const secrets: WakeSecrets = {
    githubToken,
    mindCredential: injection ? INJECTED_CREDENTIAL_PLACEHOLDER : mindCredential
  };
  // Money bearers are per-agent (spec 0002 §3): each wake receives only
  // its OWN till token, so a compromised wake sells only as itself. An
  // agent with no token configured simply has the door closed.
  const tillToken = context.getSecret(tillTokenVar(agent.id));
  const spendToken = context.getSecret(spendTokenVar(agent.id));
  const vaultToken = context.getSecret(vaultTokenVar(agent.id));
  const xToken = context.getSecret(xTokenVar(agent.id));
  return {
    wakeId,
    agentId: agent.id,
    trigger,
    env: wakeEnv(
      { wakeId, trigger, agent },
      secrets,
      {
        ...context.options,
        ...(tillToken ? { tillToken } : {}),
        ...(spendToken ? { spendToken } : {}),
        ...(vaultToken ? { vaultToken } : {}),
        ...(xToken ? { xToken } : {})
      }
    ),
    credentialInjectionHosts
  };
}
