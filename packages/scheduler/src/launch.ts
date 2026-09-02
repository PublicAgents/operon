import { doorHost } from "./umbilical-routes.js";
import { closedDoors, disabledDoors, type DoorOverrides } from "./doors.js";
import {
  wakeEnv,
  type RosterAgent,
  type WakeTrigger,
  type WakeSecrets,
  type WakeOptions,
  type Door
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

/** "promoter" -> "ASKS_TOKEN_PROMOTER" (the decision queue is per-agent). */
export function asksTokenVar(agentId: string): string {
  return `ASKS_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
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
  /** The operator's runtime door overrides for the agent (spec 0006 §7); none when absent. */
  getDoorOverrides?(agentId: string): Promise<DoorOverrides>;
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
  /**
   * Virtual hosts for the MCP servers this agent was granted (spec 0008
   * §4). The WakeContainer intercepts exactly these, so an ungranted
   * server's host routes nowhere at all.
   */
  mcpHosts: string[];
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
  // The doors matrix (spec 0006 §7): baseline from the roster, override
  // from the operator's store. A closed door is simply not wired: no
  // URL, no bearer, so the porch answers not_wired and the umbilical
  // has nothing to route. The container is told which doors the
  // operator closed, so the living help can say so rather than "not
  // wired", which would send the mind looking for a missing secret.
  const overrides = (await context.getDoorOverrides?.(agent.id)) ?? {};
  const closed = closedDoors(agent, overrides);
  const disabled = disabledDoors(agent, overrides);
  const open = (door: Door) => !closed.has(door);
  const doorOptions = {
    // These three are called with the URL DIRECTLY (the caller appends no
    // path), so the route lives in the URL; the others append their own.
    ...(open("notify")
      ? { notifyUrl: "http://" + doorHost("notify") + "/notify", notifyToken: umbilicalNonce }
      : {}),
    ...(open("publish")
      ? { publishUrl: "http://" + doorHost("publish") + "/gatekeeper/publish", publishToken: umbilicalNonce }
      : {}),
    persistUrl: "http://" + doorHost("persist") + "/commit",
    persistToken: umbilicalNonce,
    ...(open("github")
      ? { prUrl: "http://" + doorHost("pr") + "/gatekeeper/pr", prToken: umbilicalNonce }
      : {}),
    ...(open("email") ? { emailUrl: "http://" + doorHost("email"), emailToken: umbilicalNonce } : {}),
    chronicleUrl: "http://" + doorHost("chronicle"),
    chronicleToken: umbilicalNonce,
    ...(open("till") ? { tillUrl: "http://" + doorHost("till") } : {}),
    ...(open("pay") ? { spendUrl: "http://" + doorHost("spend") } : {}),
    ...(open("vault") ? { vaultUrl: "http://" + doorHost("vault") } : {}),
    ...(open("x") ? { xUrl: "http://" + doorHost("x") } : {}),
    ...(open("asks") ? { asksUrl: "http://" + doorHost("asks") } : {}),
    // The web door is opt-in per agent (spec 0004): only a web-capable
    // agent gets it, and only such a container launches fenced, so a
    // web upgrade can never arrive from an unfenced container. Its
    // baseline IS the opt-in flag, so a closed web door covers both.
    ...(open("web")
      ? { webUrl: "http://" + doorHost("web"), webToken: umbilicalNonce }
      : {}),
    ...(disabled.length > 0 ? { disabledDoors: JSON.stringify(disabled) } : {})
  };
  // The agent's own GitHub grants ride into the wake so the porch can
  // pre-check them and the living help can state them (spec 0008 §6).
  // The Gatekeepers re-read the roster and remain authoritative; this
  // is the container's copy, not its authority.
  // The switch is the presence of the block, not of a key inside it:
  // an agent whose roster entry says `github:` has per-agent grants,
  // and a missing list inside means nothing rather than the fleet's.
  const githubGrants = agent.github
    ? {
        githubGrants: JSON.stringify({
          pr: agent.github.pr ?? [],
          write: agent.github.write ?? []
        })
      }
    : {};

  // The servers this agent may reach, resolved once here so the
  // WakeContainer intercepts exactly them and the container is handed
  // their virtual hosts and nothing else (spec 0008 §4).
  const mcpServers = (open("mcp") ? (agent.mcp ?? []) : []).map(name => ({
    name,
    virtual: `mcp-${name}.operon.internal`
  }));
  const mcpEnv = mcpServers.length > 0
    ? {
        mcpServers: JSON.stringify(mcpServers.map(s => ({ ...s, type: "http" as const }))),
        // The MCP doors carry the same per-wake nonce as every other
        // door, in their own variable: borrowing the web door's would
        // make MCP access depend on browser access.
        mcpToken: umbilicalNonce
      }
    : {};

  const secrets: WakeSecrets = { githubToken, mindCredential };
  // A per-agent door (spec 0002 §3) is open only when its REAL bearer is
  // configured in the scheduler env; the container then carries the nonce
  // as that door's token, never the real bearer (the umbilical router
  // attaches the real one from env, keyed to this agent).
  const perAgent = {
    ...(open("till") && context.getSecret(tillTokenVar(agent.id)) ? { tillToken: umbilicalNonce } : {}),
    ...(open("pay") && context.getSecret(spendTokenVar(agent.id)) ? { spendToken: umbilicalNonce } : {}),
    ...(open("vault") && context.getSecret(vaultTokenVar(agent.id)) ? { vaultToken: umbilicalNonce } : {}),
    ...(open("x") && context.getSecret(xTokenVar(agent.id)) ? { xToken: umbilicalNonce } : {}),
    ...(open("asks") && context.getSecret(asksTokenVar(agent.id)) ? { asksToken: umbilicalNonce } : {})
  };
  return {
    wakeId,
    agentId: agent.id,
    trigger,
    env: wakeEnv(
      { wakeId, trigger, agent },
      secrets,
      { ...context.options, ...doorOptions, ...perAgent, ...githubGrants, ...mcpEnv }
    ),
    umbilicalNonce,
    mcpHosts: mcpServers.map(server => server.virtual)
  };
}
