import { join } from "node:path";
import { chassisHooks, CredentialShapeError, denylistable, type HarnessAdapter, type StageInput } from "./types.js";
import { renderToml, type TomlTable } from "./toml.js";
import { claudeUsageAccumulator, claudeUsageFrom } from "../usage.js";

/**
 * Grok Build CLI adapter (spec 0010 §4a): the third harness. Headless
 * `grok -p`, its home staged per wake under the mind's own (GROK_HOME),
 * a login written from the mind credential or an API key on XAI_API_KEY,
 * everything account-attached switched off in config and in the session
 * environment.
 *
 * Two credential shapes: the JSON of a `grok login` (auth.json, which
 * Grok may refresh in place and the entrypoint watches, spec 0010 §5),
 * or an API key, which rides XAI_API_KEY into the session. The shape is
 * decided here, once, by parsing; anything that is neither is refused
 * by name rather than written somewhere Grok would misread.
 *
 * Usage is Claude Code's stream-json shape: the session asks for
 * `--output-format streaming-messages-json`, whose terminal `result`
 * event is what claudeUsageFrom already reads. External OTEL stays off:
 * Grok speaks protobuf, the porch is JSON (spec 0011).
 */

const PROBE_QUESTION = "Reply with only the exact model id you are running as, nothing else.";

/** Unattended, streamed: the container is the sandbox; the JSONL stream is the transcript. */
export const GROK_SESSION_ARGS = [
  "--permission-mode",
  "bypassPermissions",
  "--output-format",
  "streaming-messages-json"
];

/** Every grok invocation: the image pins the version, a wake must not self-update. */
export const GROK_INVARIANT_ARGS = ["--no-auto-update"];

export const GROK_AUTH_FILE = "auth.json";

/**
 * Everything account-attached or interactive, off. Environment variables
 * outrank config.toml, so a mind that edits its staged file mid-session
 * cannot turn these back on.
 */
export const GROK_LOCKDOWN_ENV: Record<string, string> = {
  GROK_DISABLE_AUTOUPDATER: "1",
  GROK_MEMORY: "0",
  GROK_ASK_USER_QUESTION: "0",
  GROK_TELEMETRY_ENABLED: "0",
  GROK_TELEMETRY_TRACE_UPLOAD: "0",
  GROK_TELEMETRY_MIXPANEL_ENABLED: "0",
  GROK_FEEDBACK_ENABLED: "0",
  GROK_EXTERNAL_OTEL: "0",
  GROK_WORKFLOWS: "0",
  GROK_MANAGED_MCPS_ENABLED: "0",
  GROK_CLAUDE_AGENTS_ENABLED: "0",
  GROK_CLAUDE_HOOKS_ENABLED: "0",
  GROK_CLAUDE_MCPS_ENABLED: "0",
  GROK_CLAUDE_RULES_ENABLED: "0",
  GROK_CLAUDE_SKILLS_ENABLED: "0",
  GROK_CURSOR_AGENTS_ENABLED: "0",
  GROK_CURSOR_HOOKS_ENABLED: "0",
  GROK_CURSOR_MCPS_ENABLED: "0",
  GROK_CURSOR_RULES_ENABLED: "0",
  GROK_CURSOR_SKILLS_ENABLED: "0"
};

export function grokHome(home: string): string {
  return join(home, ".grok");
}

/** A login file is JSON with an access_token or an issuer entry that holds a key. */
export function grokCredentialShape(credential: string): { kind: "login" } | { kind: "apiKey" } {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) {
    if (trimmed.length === 0 || /\s/.test(trimmed)) {
      throw new CredentialShapeError("grok", "is neither a grok login file (JSON) nor an API key");
    }
    return { kind: "apiKey" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new CredentialShapeError("grok", "looks like JSON but does not parse");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialShapeError("grok", "is JSON but not an object (not a grok login file)");
  }
  if (!isGrokLogin(parsed as Record<string, unknown>)) {
    throw new CredentialShapeError(
      "grok",
      "is JSON without a grok login (issuer entries with a key, or an access_token)"
    );
  }
  return { kind: "login" };
}

function isGrokLogin(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.access_token === "string" && parsed.access_token.length > 0) return true;
  for (const value of Object.values(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.key === "string" && entry.key.length > 0) return true;
    if (typeof entry.access_token === "string" && entry.access_token.length > 0) return true;
  }
  return false;
}

/**
 * Keys whose values are identity or bookkeeping, never a token: the
 * account holder's name in the journal must not cost the wake its
 * persist (it did, once). A value with whitespace in it is a name or
 * a sentence, never a token, whatever its key.
 */
const NOT_A_SECRET = new Set([
  "account_id",
  "issuer",
  "email",
  "name",
  "display_name",
  "full_name",
  "given_name",
  "family_name",
  "username",
  "user_name",
  "login",
  "sub",
  "iss",
  "aud",
  "auth_mode",
  "token_type",
  "scope",
  "expires_in",
  "expires_at",
  "created_at",
  "updated_at",
  "last_refresh",
  "plan",
  "tier",
  "org",
  "organization"
]);

/** Keys that hold a credential by definition: denylisted whatever the value looks like. */
const CREDENTIAL_KEYS = new Set(["key", "access_token", "refresh_token", "refresh", "id_token", "token", "secret", "api_key", "password", "jwt"]);

function secretStrings(value: unknown, key?: string): string[] {
  if (typeof value === "string") {
    if (key !== undefined && CREDENTIAL_KEYS.has(key)) return value.length > 0 ? [value] : [];
    if (key !== undefined && NOT_A_SECRET.has(key)) return [];
    if (/\s/.test(value)) return [];
    return denylistable(value) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap(entry => secretStrings(entry));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([nested, entry]) => secretStrings(entry, nested));
  }
  return [];
}

/** The config that turns off everything account-attached (spec 0010 §4a). */
export function grokConfig(mcp: StageInput["mcp"]): TomlTable {
  const config: TomlTable = {
    cli: { auto_update: false },
    features: {
      telemetry: false,
      feedback: false,
      ask_user_question: false,
      image_gen: false,
      video_gen: false,
      managed_config: false,
      remote_fetch: false
    },
    memory: { enabled: false },
    workflows: { enabled: false },
    managed_mcps: { enabled: false },
    compat: {
      claude: { skills: false, rules: false, agents: false, mcps: false, hooks: false },
      cursor: { skills: false, rules: false, agents: false, mcps: false, hooks: false }
    }
  };
  if (mcp) {
    const servers: TomlTable = {};
    for (const [name, entry] of Object.entries(mcp.mcpServers)) {
      if (entry.command) {
        servers[name] = { command: entry.command, ...(entry.args ? { args: entry.args } : {}) };
      } else if (entry.url) {
        servers[name] = { url: entry.url, ...(entry.headers ? { headers: { ...entry.headers } } : {}) };
      }
    }
    config.mcp_servers = servers;
  }
  return config;
}

/** An API key rides the session env; a login file is already staged in GROK_HOME. */
function credentialEnv(credential: string): Record<string, string> {
  return grokCredentialShape(credential).kind === "apiKey" ? { XAI_API_KEY: credential } : {};
}

export const grok: HarnessAdapter = {
  id: "grok",
  // XAI_API_KEY would switch auth to usage billing behind a subscription's
  // back; GROK_HOME of the image's would be a home we did not stage; the
  // base-URL and overlay variables would move the endpoint or inject
  // config the chassis did not write.
  forbiddenEnv: [
    "XAI_API_KEY",
    "GROK_HOME",
    "GROK_CLI_CHAT_PROXY_BASE_URL",
    "GROK_XAI_API_BASE_URL",
    "GROK_MODELS_BASE_URL",
    "GROK_CONFIG",
    "GROK_CONFIG_PATH",
    "GROK_AUTH_PROVIDER_COMMAND",
    "GROK_OIDC_ISSUER",
    "GROK_DEPLOYMENT_KEY",
    "GROK_SANDBOX"
  ],
  lockdownEnv: GROK_LOCKDOWN_ENV,

  credentialFile(credential) {
    return grokCredentialShape(credential).kind === "login" ? join(".grok", GROK_AUTH_FILE) : undefined;
  },

  stage(input) {
    const home = grokHome(input.home);
    const shape = grokCredentialShape(input.credential);
    const files = [
      { path: join(home, "config.toml"), content: renderToml(grokConfig(input.mcp)), mode: 0o600 },
      {
        path: join(home, "hooks", "operon.json"),
        content: JSON.stringify({ hooks: chassisHooks(input.hooks, undefined) }, null, 2) + "\n",
        mode: 0o600
      }
    ];
    const lines = [
      "grok: config staged (lockdown: memory, plugins-compat, telemetry, updates, ask_user_question, image/video gen, managed MCP off)",
      "grok: hooks staged under GROK_HOME/hooks (always trusted; PostToolUse pull hook, Stop journal guard)",
      "grok: project .grok stays untrusted (folder-trust on; no --trust), so its config, hooks, and MCP servers stay off"
    ];
    if (shape.kind === "login") {
      files.push({ path: join(home, GROK_AUTH_FILE), content: input.credential, mode: 0o600 });
      lines.push("grok: login file staged from the mind credential");
    } else {
      lines.push("grok: API-key credential (rides XAI_API_KEY; nothing to relay)");
    }
    lines.push(
      input.telemetry
        ? `grok: usage is read from the stream; vendor telemetry off (external OTEL is protobuf, porch is JSON at ${input.telemetry.endpoint})`
        : "grok: telemetry off (no chronicle door this wake)"
    );
    return {
      files,
      args: [],
      env: { GROK_HOME: home, ...GROK_LOCKDOWN_ENV },
      lines
    };
  },

  secretsIn(credential) {
    const shape = grokCredentialShape(credential);
    if (shape.kind === "apiKey") return [credential];
    return [credential, ...secretStrings(JSON.parse(credential) as unknown)];
  },

  usageAccumulator() {
    return claudeUsageAccumulator();
  },

  usageFrom(lines) {
    return claudeUsageFrom(lines);
  },

  probe(model, credential) {
    return {
      command: "grok",
      args: [
        "-p",
        PROBE_QUESTION,
        "-m",
        model,
        ...GROK_INVARIANT_ARGS,
        "--permission-mode",
        "dontAsk",
        "--disable-web-search"
      ],
      env: { ...GROK_LOCKDOWN_ENV, ...credentialEnv(credential) }
    };
  },

  // Grok has no fallback-model flag: the entrypoint's probe-then-fallback
  // covers an unavailable pinned model before the session (spec 0010 §4a).
  session(prompt, model, credential) {
    return {
      command: "grok",
      args: ["-p", prompt, "-m", model, ...GROK_INVARIANT_ARGS, ...GROK_SESSION_ARGS],
      env: { ...GROK_LOCKDOWN_ENV, ...credentialEnv(credential) }
    };
  }
};
