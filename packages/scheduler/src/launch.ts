import { doorHost } from "./umbilical-routes.js";
import {
  accessTokenExpiry,
  chooseCredential,
  credentialFingerprint,
  loginNeedsRefresh,
  parseCodexLogin
} from "./mind-credential.js";
import { closedDoors, disabledDoors, type DoorOverrides } from "./doors.js";
import {
  EgressTableError,
  parseEgressPolicy,
  resolveEgressPolicy,
  isHarness,
  wakeEnv,
  KNOWN_HARNESSES,
  type MindPin,
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

/**
 * The operator's extra session arguments are per harness (spec 0010 §5):
 * "claude-code" keeps the historical HARNESS_EXTRA_ARGS name, every other
 * harness reads HARNESS_EXTRA_ARGS_<HARNESS>.
 */
export function harnessExtraArgsVar(harness: string): string {
  return harness === "claude-code"
    ? "HARNESS_EXTRA_ARGS"
    : `HARNESS_EXTRA_ARGS_${harness.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Which mind a wake runs on (spec 0010 §4): the agent's primary unless
 * the caller named one of its alternates. Anything else is refused by
 * name before a container is touched: an unknown harness, and a known
 * one the roster gave this agent no model for.
 */
export function resolveMind(agent: RosterAgent, harness?: string): MindPin {
  if (harness === undefined || harness === agent.harness) {
    return {
      harness: agent.harness,
      model: agent.model,
      ...(agent.fallbackModel ? { fallbackModel: agent.fallbackModel } : {})
    };
  }
  if (!isHarness(harness)) {
    throw new LaunchPreconditionError(
      "unknown_harness",
      `"${harness}" is not a harness (known: ${KNOWN_HARNESSES.join(", ")})`
    );
  }
  const pin = agent.harnesses?.[harness];
  if (!pin) {
    throw new LaunchPreconditionError(
      "harness_not_configured",
      `agent ${agent.id} has no model pinned for harness "${harness}" (roster agents[].harnesses)`
    );
  }
  return { harness, ...pin };
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
  /** The stored refresh of a file credential (spec 0010 §5), with the seed it descends from. */
  getRefreshedCredential?(harness: string): Promise<{ seed: string; value: string } | undefined>;
  /** Refresh a Codex login against the authority; returns the new file. Throws RefreshError. */
  refreshLogin?(login: string): Promise<string>;
  /** Keep a refreshed credential for later launches under the seed it descends from. */
  storeRefreshedCredential?(harness: string, seed: string, value: string): Promise<void>;
  /** The launch's own log line (the Worker console by default). */
  log?(line: string): void;
  /** Mints a short-lived token scoped to the agent's state repo. */
  getGithubToken(agent: RosterAgent): Promise<string>;
  options: WakeOptions;
}

export interface PreparedLaunch {
  wakeId: string;
  agentId: string;
  trigger: WakeTrigger;
  /** The harness this wake runs on (spec 0010 §4). */
  harness: string;
  env: Record<string, string>;
  /**
   * The umbilical (spec 0003 step 4): the container's door URLs point at
   * virtual `<door>.operon.internal` hosts and every door token is this
   * per-wake NONCE. The WakeContainer intercepts that egress, validates
   * the nonce, swaps in the real bearer from the scheduler env, and
   * forwards over a binding, so no door credential enters the container.
   */
  umbilicalNonce: string;
  /** Every door closed for this wake (spec 0006 §7), for the router to refuse. */
  closedDoors: Door[];
  /**
   * Virtual hosts for the MCP servers this agent was granted (spec 0008
   * §4). The WakeContainer intercepts exactly these, so an ungranted
   * server's host routes nowhere at all.
   */
  mcpHosts: string[];
}

/**
 * Refresh a Codex login when it is due. A refusal by the authority
 * (expired, reused, revoked) while the access token is still valid
 * lets the wake run on what it has, named in the log; once the access
 * token is gone too, the wake is refused by name: the operator must
 * authorize again, and nothing the container could do would help.
 */
async function refreshIfDue(
  harness: string,
  credential: string,
  seedFingerprint: string,
  context: LaunchContext
): Promise<string> {
  const login = parseCodexLogin(credential);
  if (!login || !context.refreshLogin) return credential;
  const now = Date.now();
  if (!loginNeedsRefresh(login, now)) return credential;
  const log = context.log ?? (line => console.log(line));
  try {
    const refreshed = await context.refreshLogin(credential);
    await context.storeRefreshedCredential?.(harness, seedFingerprint, refreshed);
    log(`mind credential (${harness}): login refreshed by the scheduler and stored for later launches`);
    return refreshed;
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
    const expiry = accessTokenExpiry(login);
    if (expiry !== undefined && expiry > now) {
      log(`mind credential (${harness}): refresh failed (${detail}); the access token is still valid, waking on it`);
      return credential;
    }
    throw new LaunchPreconditionError(
      "mind_credential_refresh_failed",
      `${detail}; the access token has expired too: authorize the ${harness} account again (npm run authorize:codex)`
    );
  }
}

export async function prepareLaunch(
  agent: RosterAgent,
  trigger: WakeTrigger,
  wakeId: string,
  context: LaunchContext,
  harness?: string
): Promise<PreparedLaunch> {
  const mind = resolveMind(agent, harness);
  const credentialVar = mindCredentialVar(mind.harness);
  const seededCredential = context.getSecret(credentialVar);
  if (!seededCredential) {
    throw new LaunchPreconditionError(
      "mind_credential_missing",
      `secret ${credentialVar} is not configured for harness "${mind.harness}"`
    );
  }
  // A file credential rotates (spec 0010 §5): the launch starts from
  // the stored refresh while it descends from the CURRENT secret (the
  // operator's re-authorize wins by construction), and refreshes it
  // here, a day before the harness would inside the container.
  const seedFingerprint = await credentialFingerprint(seededCredential);
  const chosen = chooseCredential(
    seededCredential,
    seedFingerprint,
    await context.getRefreshedCredential?.(mind.harness)
  );
  const mindCredential = await refreshIfDue(mind.harness, chosen.value, seedFingerprint, context);
  // The operator's session policy for THIS harness (spec 0010 §5); a
  // harness with none configured runs on the adapter's own defaults.
  const harnessExtraArgs = context.getSecret(harnessExtraArgsVar(mind.harness));
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
  // A closed GitHub door also closes the branch door: the write grants
  // are withheld (the porch pre-checks them) and the router refuses the
  // branch route, so persist keeps only the state commit.
  const githubGrants = agent.github
    ? {
        githubGrants: JSON.stringify({
          pr: open("github") ? (agent.github.pr ?? []) : [],
          write: open("github") ? (agent.github.write ?? []) : []
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

  // The outbound proxy policy (spec 0004 §8) names each proxy's
  // credential; the values are scheduler secrets, substituted here so
  // the committed var never holds one and the container receives the
  // policy it can use. A named credential without its secret fails the
  // launch by name, like a missing mind credential.
  let egressProxy: { egressProxy: string } | Record<string, never> = {};
  if (context.options.egressProxy !== undefined) {
    try {
      egressProxy = {
        egressProxy: resolveEgressPolicy(parseEgressPolicy(context.options.egressProxy), name => context.getSecret(name))
      };
    } catch (error) {
      if (error instanceof EgressTableError) throw new LaunchPreconditionError(error.code, error.message);
      throw error;
    }
  }

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
    harness: mind.harness,
    env: wakeEnv(
      { wakeId, trigger, agent, mind },
      secrets,
      {
        ...context.options,
        ...(harnessExtraArgs ? { harnessExtraArgs } : {}),
        ...doorOptions,
        ...perAgent,
        ...githubGrants,
        ...mcpEnv,
        ...egressProxy
      }
    ),
    umbilicalNonce,
    mcpHosts: mcpServers.map(server => server.virtual),
    closedDoors: [...closed]
  };
}
