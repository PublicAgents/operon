import { doorHost } from "./umbilical-routes.js";
import {
  wakeEnv,
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
   * The umbilical (spec 0003 step 4): the container's door URLs point at
   * virtual `<door>.operon.internal` hosts and every door token is this
   * per-wake NONCE. The WakeContainer intercepts that egress, validates
   * the nonce, swaps in the real bearer from the scheduler env, and
   * forwards over a binding, so no door credential enters the container.
   */
  umbilicalNonce: string;
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
  // The umbilical rewrites every door to a virtual host with the per-wake
  // nonce as its bearer; the real bearers stay in the scheduler env and
  // the WakeContainer's router attaches them. The mind credential and the
  // github clone token are phase 2, untouched here.
  const umbilicalNonce = crypto.randomUUID();
  const doorOptions = {
    // These three are called with the URL DIRECTLY (the caller appends no
    // path), so the route lives in the URL; the others append their own.
    notifyUrl: "http://" + doorHost("notify") + "/notify",
    notifyToken: umbilicalNonce,
    publishUrl: "http://" + doorHost("publish") + "/gatekeeper/publish",
    publishToken: umbilicalNonce,
    persistUrl: "http://" + doorHost("persist") + "/commit",
    persistToken: umbilicalNonce,
    prUrl: "http://" + doorHost("pr") + "/gatekeeper/pr",
    prToken: umbilicalNonce,
    emailUrl: "http://" + doorHost("email"),
    emailToken: umbilicalNonce,
    chronicleUrl: "http://" + doorHost("chronicle"),
    chronicleToken: umbilicalNonce,
    tillUrl: "http://" + doorHost("till"),
    spendUrl: "http://" + doorHost("spend"),
    vaultUrl: "http://" + doorHost("vault"),
    xUrl: "http://" + doorHost("x")
  };
  const secrets: WakeSecrets = { githubToken, mindCredential };
  // A per-agent door (spec 0002 §3) is open only when its REAL bearer is
  // configured in the scheduler env; the container then carries the nonce
  // as that door's token, never the real bearer (the umbilical router
  // attaches the real one from env, keyed to this agent).
  const perAgent = {
    ...(context.getSecret(tillTokenVar(agent.id)) ? { tillToken: umbilicalNonce } : {}),
    ...(context.getSecret(spendTokenVar(agent.id)) ? { spendToken: umbilicalNonce } : {}),
    ...(context.getSecret(vaultTokenVar(agent.id)) ? { vaultToken: umbilicalNonce } : {}),
    ...(context.getSecret(xTokenVar(agent.id)) ? { xToken: umbilicalNonce } : {})
  };
  return {
    wakeId,
    agentId: agent.id,
    trigger,
    env: wakeEnv(
      { wakeId, trigger, agent },
      secrets,
      { ...context.options, ...doorOptions, ...perAgent }
    ),
    umbilicalNonce
  };
}
