/**
 * The relay is a POLICY POINT, not a transparent pipe (spec 0004
 * section 2). A raw CDP connection can export the very credentials the
 * door protects, so the relay refuses those methods, owns WebAuthn,
 * checks navigation against the origin denylist, and substitutes vault
 * secrets as DATA on the fill paths.
 *
 * Pure: every decision is a function of the frame plus policy, so it is
 * unit-tested without a Workers runtime.
 */

/** CDP methods that read or export credentials; refused at the relay. */
export const BLOCKED_METHODS = new Set<string>([
  "Network.getCookies",
  "Network.getAllCookies",
  "Storage.getCookies",
  "Storage.getStorageKeyForFrame"
]);

/** Whole domains the container may never drive; the DO owns them. */
export const BLOCKED_DOMAINS = new Set<string>([
  // The virtual authenticator and its credentials belong to the relay,
  // exactly as the Cloudflare API token does; the mind never touches it.
  "WebAuthn"
]);

/** Methods that put text into the page, where a placeholder may appear. */
export const FILL_METHODS = new Set<string>([
  "Input.insertText",
  "Input.dispatchKeyEvent",
  "Runtime.evaluate",
  "Runtime.callFunctionOn"
]);

/** `{{vault:web/<name>}}`; the token alphabet is syntax-inert on purpose. */
export const PLACEHOLDER = /\{\{vault:web\/([a-z0-9][a-z0-9-]{0,63})\}\}/g;

export interface RelayPolicy {
  /** Hostnames (or `*.suffix` globs) navigation may never reach. */
  originDenylist?: string[];
  /** Secrets available for substitution, by credential name. */
  credentials?: Record<string, { value: string; domains: string[] }>;
}

export type CdpDecision =
  | { action: "forward" }
  | { action: "block"; response: string; method: string; reason: string }
  | { action: "resolve-origin"; method: string; credential: string; raw: string };

function cdpError(message: { id?: unknown; sessionId?: unknown }, text: string): string {
  return JSON.stringify({
    id: typeof message.id === "number" ? message.id : 0,
    error: { code: -32601, message: text },
    ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {})
  });
}

/** Does `host` match a denylist entry (exact, or a `*.suffix` glob)? */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().trim();
  if (!p) return false;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) || h === suffix.slice(1);
  }
  return h === p;
}

/** A credential bound to a domain covers that domain and its subdomains. */
export function originOnDomain(origin: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some(domain => {
    const d = domain.toLowerCase().replace(/^\*\./, "").trim();
    if (!d) return false;
    return host === d || host.endsWith(`.${d}`);
  });
}

/**
 * Decide a single client -> upstream CDP frame.
 *
 * `resolve-origin` means a placeholder was found: the relay must ask the
 * browser for the TARGET CONTEXT's origin before it may inject, then
 * call `applyFill`.
 */
export function cdpDecision(frame: string, policy: RelayPolicy = {}): CdpDecision {
  if (frame.length === 0 || frame[0] !== "{") return { action: "forward" };
  let message: {
    id?: unknown;
    method?: unknown;
    sessionId?: unknown;
    params?: Record<string, unknown>;
  };
  try {
    message = JSON.parse(frame);
  } catch {
    return { action: "forward" };
  }
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) return { action: "forward" };

  // 1. Credential export: refused outright.
  const domain = method.slice(0, method.indexOf("."));
  if (BLOCKED_METHODS.has(method) || BLOCKED_DOMAINS.has(domain)) {
    return {
      action: "block",
      response: cdpError(message, `blocked_by_operon: ${method}`),
      method,
      reason: "credential_export"
    };
  }

  // 2. Navigation against the origin denylist (the relay half; Browser
  //    Run's own allowedDomainSets is the platform half).
  if (method === "Page.navigate" && policy.originDenylist?.length) {
    const url = message.params?.url;
    if (typeof url === "string") {
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        host = "";
      }
      if (host && policy.originDenylist.some(pattern => hostMatches(host, pattern))) {
        return {
          action: "block",
          response: cdpError(message, `blocked_by_operon: denied origin ${host}`),
          method,
          reason: "origin_denied"
        };
      }
    }
  }

  // 3. A vault placeholder on a fill path needs the target origin first.
  if (FILL_METHODS.has(method)) {
    const found = findPlaceholder(message.params);
    if (found) return { action: "resolve-origin", method, credential: found, raw: frame };
  }

  return { action: "forward" };
}

/** The first `{{vault:web/<name>}}` anywhere in the params, or null. */
export function findPlaceholder(params: unknown): string | null {
  if (params === null || params === undefined) return null;
  if (typeof params === "string") {
    PLACEHOLDER.lastIndex = 0;
    const match = PLACEHOLDER.exec(params);
    return match ? match[1] : null;
  }
  if (Array.isArray(params)) {
    for (const item of params) {
      const found = findPlaceholder(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof params === "object") {
    for (const value of Object.values(params as Record<string, unknown>)) {
      const found = findPlaceholder(value);
      if (found) return found;
    }
  }
  return null;
}

export type FillOutcome =
  | { ok: true; frame: string }
  | { ok: false; response: string; reason: string };

/**
 * Inject the credential once the target origin is known. The value is
 * always DATA, never spliced into JavaScript SOURCE: a password holds
 * quotes, backslashes and `${`, so concatenating it into an expression
 * would corrupt the fill and open a code-injection path.
 *
 * - `Input.*`: the text field is data already.
 * - `Runtime.callFunctionOn`: substituted in an ARGUMENT value, never in
 *   `functionDeclaration`.
 * - `Runtime.evaluate`: a placeholder inside the expression SOURCE is
 *   refused, with an error telling the client to use an argument path.
 */
export function applyFill(
  raw: string,
  credentialName: string,
  targetOrigin: string,
  policy: RelayPolicy
): FillOutcome {
  const message = JSON.parse(raw) as {
    id?: unknown;
    method?: string;
    sessionId?: unknown;
    params?: Record<string, unknown>;
  };
  const credential = policy.credentials?.[credentialName];
  if (!credential) {
    return {
      ok: false,
      response: cdpError(message, `blocked_by_operon: no credential ${credentialName}`),
      reason: "unknown_credential"
    };
  }
  if (!targetOrigin || !originOnDomain(targetOrigin, credential.domains)) {
    return {
      ok: false,
      response: cdpError(
        message,
        `blocked_by_operon: ${credentialName} is not bound to ${targetOrigin || "an unresolved origin"}`
      ),
      reason: "origin_unbound"
    };
  }

  const method = message.method ?? "";
  const params = (message.params ?? {}) as Record<string, unknown>;

  if (method === "Runtime.evaluate") {
    const expression = params.expression;
    if (typeof expression === "string" && hasPlaceholder(expression)) {
      return {
        ok: false,
        response: cdpError(
          message,
          "blocked_by_operon: a credential cannot be spliced into evaluate() source; " +
            "pass it as a callFunctionOn argument instead"
        ),
        reason: "source_splice_refused"
      };
    }
  }

  if (method === "Runtime.callFunctionOn") {
    const declaration = params.functionDeclaration;
    if (typeof declaration === "string" && hasPlaceholder(declaration)) {
      return {
        ok: false,
        response: cdpError(
          message,
          "blocked_by_operon: a credential cannot be spliced into a function body; " +
            "pass it as an argument value instead"
        ),
        reason: "source_splice_refused"
      };
    }
    const args = params.arguments;
    if (Array.isArray(args)) {
      params.arguments = args.map(argument => {
        if (argument && typeof argument === "object" && "value" in argument) {
          const holder = argument as { value?: unknown };
          if (typeof holder.value === "string") {
            return { ...holder, value: replace(holder.value, credential.value) };
          }
        }
        return argument;
      });
      message.params = params;
      return { ok: true, frame: JSON.stringify(message) };
    }
  }

  // Input.* (and any other data-carrying field): substitute in place.
  message.params = substituteStrings(params, credential.value) as Record<string, unknown>;
  return { ok: true, frame: JSON.stringify(message) };
}

/**
 * The response path: a fill puts the real password INTO the page, so an
 * ordinary placeholder-free `Runtime.evaluate` could read it back out
 * (`input.value`) and the mind would learn a value it must never hold.
 * Every upstream frame is therefore scanned for known credential values
 * and they are redacted before the client sees them. The mind gets the
 * placeholder back, which is exactly what it typed.
 */
export function redactCredentials(frame: string, policy: RelayPolicy): { frame: string; redacted: string[] } {
  const credentials = policy.credentials;
  if (!credentials) return { frame, redacted: [] };
  let out = frame;
  const redacted: string[] = [];
  for (const [name, credential] of Object.entries(credentials)) {
    if (!credential.value || credential.value.length < 8) continue;
    // JSON-encoded frames carry escaped forms of the value too.
    const encoded = JSON.stringify(credential.value).slice(1, -1);
    for (const needle of new Set([credential.value, encoded])) {
      if (out.includes(needle)) {
        out = out.split(needle).join(`{{vault:web/${name}}}`);
        if (!redacted.includes(name)) redacted.push(name);
      }
    }
  }
  return { frame: out, redacted };
}

function hasPlaceholder(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}

function replace(text: string, value: string): string {
  PLACEHOLDER.lastIndex = 0;
  return text.replace(PLACEHOLDER, value);
}

function substituteStrings(node: unknown, value: string): unknown {
  if (typeof node === "string") return replace(node, value);
  if (Array.isArray(node)) return node.map(item => substituteStrings(item, value));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      out[key] = substituteStrings(item, value);
    }
    return out;
  }
  return node;
}
