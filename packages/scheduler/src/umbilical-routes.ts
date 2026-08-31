/**
 * The umbilical's pure routing (spec 0003 step 4), runtime-free so it is
 * unit-tested without the Workers runtime. The entrypoint in umbilical.ts
 * wraps it.
 */

interface DoorRoute {
  binding: string;
  /** Shared bearer env name, or the per-agent bearer prefix. */
  bearerEnv?: string;
  perAgentPrefix?: string;
  /** Binding-only door: no bearer exists or is attached; the private
   * service binding IS the auth (the target worker has no public
   * surface) and identity rides x-operon-agent. */
  bearerless?: boolean;
}

/** virtual host label -> Gatekeeper binding + which bearer to attach. */
export const DOOR_ROUTES: Record<string, DoorRoute> = {
  notify: { binding: "TELEGRAM", bearerEnv: "NOTIFY_TOKEN" },
  email: { binding: "EMAIL", bearerEnv: "EMAIL_TOKEN" },
  publish: { binding: "DEPLOY", bearerEnv: "PUBLISH_TOKEN" },
  persist: { binding: "GITHUB", bearerEnv: "PERSIST_TOKEN" },
  pr: { binding: "PR", bearerEnv: "PR_TOKEN" },
  chronicle: { binding: "CHRONICLE", bearerEnv: "CHRONICLE_TOKEN" },
  till: { binding: "TILL", perAgentPrefix: "TILL_TOKEN" },
  spend: { binding: "SPEND", perAgentPrefix: "SPEND_TOKEN" },
  vault: { binding: "VAULT", perAgentPrefix: "VAULT_TOKEN" },
  x: { binding: "X", perAgentPrefix: "X_TOKEN" },
  asks: { binding: "ASKS_GK", perAgentPrefix: "ASKS_TOKEN" },
  // The web door (spec 0004): browser-gk has no public surface, so the
  // binding is the auth and no bearer rides at all.
  web: { binding: "BROWSER", bearerless: true }
};

export const INTERNAL_SUFFIX = ".operon.internal";

/** The virtual host for a door, e.g. "email" -> "email.operon.internal". */
export function doorHost(door: string): string {
  return `${door}${INTERNAL_SUFFIX}`;
}

/** All door virtual hosts (for the WakeContainer to intercept). */
export function allDoorHosts(): string[] {
  return Object.keys(DOOR_ROUTES).map(doorHost);
}

/** "promoter" -> "TILL_TOKEN_PROMOTER". */
function perAgentVar(prefix: string, agentId: string): string {
  return `${prefix}_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

/** Pure resolution (unit-tested): the binding + real bearer for a request. */
export function resolveDoor(
  hostname: string,
  env: Record<string, unknown>,
  agentId: string
): { binding: string; bearer?: string } | { error: string } {
  if (!hostname.endsWith(INTERNAL_SUFFIX)) return { error: "not_internal" };
  const door = hostname.slice(0, -INTERNAL_SUFFIX.length);
  const route = DOOR_ROUTES[door];
  if (!route) return { error: "unknown_door" };
  if (route.bearerless) return { binding: route.binding };
  const bearer = route.perAgentPrefix
    ? env[perAgentVar(route.perAgentPrefix, agentId)]
    : env[route.bearerEnv as string];
  if (typeof bearer !== "string" || bearer.length === 0) return { error: "bearer_unconfigured" };
  return { binding: route.binding, bearer };
}
