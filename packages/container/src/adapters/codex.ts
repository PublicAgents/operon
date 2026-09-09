import { join } from "node:path";
import { chassisHooks, CredentialShapeError, type HarnessAdapter, type StageInput } from "./types.js";
import { renderToml, type TomlTable } from "./toml.js";
import { codexUsageAccumulator, codexUsageFrom } from "../usage.js";

/**
 * Codex CLI adapter (spec 0010 §4): the second harness, chassis spec
 * decision 1a. Headless `codex exec`, its home staged per wake under the
 * mind's own (CODEX_HOME), its login written from the mind credential,
 * everything attached to the ChatGPT account switched off in its config.
 *
 * Two credential shapes: the JSON of a `codex login` (auth.json, which
 * Codex refreshes in place and the entrypoint relays back, spec 0010
 * §5), or an API key, which rides CODEX_API_KEY into the session. The
 * shape is decided here, once, by parsing; anything that is neither is
 * refused by name rather than written somewhere Codex would misread.
 */

const PROBE_QUESTION = "Reply with only the exact model id you are running as, nothing else.";

/** Flags every codex exec carries: the state dir is not a "trusted" project, nothing persists. */
const CODEX_INVARIANT_ARGS = ["--skip-git-repo-check", "--ephemeral", "--color", "never"];

/**
 * Unattended, streamed (spec 0010 §2): the container is the sandbox, as
 * bypassPermissions says for Claude Code, and the JSONL event stream
 * is the transcript. Part of the command, not an operator setting.
 */
export const CODEX_SESSION_ARGS = ["--dangerously-bypass-approvals-and-sandbox", "--json"];

export const CODEX_AUTH_FILE = "auth.json";

export function codexHome(home: string): string {
  return join(home, ".codex");
}

export interface CodexLogin {
  tokens: Record<string, unknown>;
}

/** A login file has a `tokens` table; an API key is a bare string; anything else is malformed. */
export function codexCredentialShape(
  credential: string
): { kind: "login"; login: CodexLogin } | { kind: "apiKey" } {
  const trimmed = credential.trim();
  if (!trimmed.startsWith("{")) {
    if (trimmed.length === 0 || /\s/.test(trimmed)) {
      throw new CredentialShapeError("codex", "is neither a codex login file (JSON) nor an API key");
    }
    return { kind: "apiKey" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new CredentialShapeError("codex", "looks like JSON but does not parse");
  }
  const tokens = (parsed as { tokens?: unknown })?.tokens;
  if (typeof tokens !== "object" || tokens === null) {
    throw new CredentialShapeError("codex", "is JSON without a tokens table (not a codex login file)");
  }
  return { kind: "login", login: { tokens: tokens as Record<string, unknown> } };
}

/** Codex's OTLP/HTTP exporter for one signal, at the porch relay (spec 0011 §4). */
function otlpHttp(endpoint: string): TomlTable {
  return { "otlp-http": { endpoint, protocol: "json", headers: { "x-operon-porch": "1" } } };
}

/** The config that turns off everything account-attached (spec 0010 §4) and exports telemetry to the chassis (spec 0011). */
export function codexConfig(mcp: StageInput["mcp"], telemetry?: StageInput["telemetry"]): TomlTable {
  const config: TomlTable = {
    cli_auth_credentials_store: "file",
    approval_policy: "never",
    check_for_update_on_startup: false,
    history: { persistence: "none" },
    analytics: { enabled: false },
    feedback: { enabled: false },
    otel: telemetry
      ? {
          environment: "operon",
          log_user_prompt: false,
          exporter: otlpHttp(`${telemetry.endpoint}/v1/logs`),
          trace_exporter: otlpHttp(`${telemetry.endpoint}/v1/traces`),
          metrics_exporter: otlpHttp(`${telemetry.endpoint}/v1/metrics`)
        }
      : { exporter: "none", trace_exporter: "none", metrics_exporter: "none", log_user_prompt: false },
    features: {
      apps: false,
      plugins: false,
      remote_plugin: false,
      tool_suggest: false,
      recommended_plugins: false,
      memories: false,
      browser_use: false,
      computer_use: false,
      in_app_updates: false
    }
  };
  if (mcp) {
    const servers: TomlTable = {};
    for (const [name, entry] of Object.entries(mcp.mcpServers)) {
      if (entry.command) {
        servers[name] = { command: entry.command, ...(entry.args ? { args: entry.args } : {}) };
      } else if (entry.url) {
        servers[name] = { url: entry.url, ...(entry.headers ? { http_headers: { ...entry.headers } } : {}) };
      }
    }
    config.mcp_servers = servers;
  }
  return config;
}

/** An API key rides the session env; a login file is already staged in CODEX_HOME. */
function credentialEnv(credential: string): Record<string, string> {
  return codexCredentialShape(credential).kind === "apiKey" ? { CODEX_API_KEY: credential } : {};
}

export const codex: HarnessAdapter = {
  id: "codex",
  // OPENAI_API_KEY and CODEX_API_KEY would switch auth to usage billing
  // behind the subscription's back; OPENAI_BASE_URL would move the
  // endpoint; a CODEX_HOME of the image's would be a home we did not stage.
  forbiddenEnv: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
  lockdownEnv: {},

  credentialFile(credential) {
    return codexCredentialShape(credential).kind === "login" ? join(".codex", CODEX_AUTH_FILE) : undefined;
  },

  stage(input) {
    const home = codexHome(input.home);
    const shape = codexCredentialShape(input.credential);
    const files = [
      { path: join(home, "config.toml"), content: renderToml(codexConfig(input.mcp, input.telemetry)), mode: 0o600 },
      {
        path: join(home, "hooks.json"),
        content: JSON.stringify({ hooks: chassisHooks(input.hooks, undefined) }, null, 2) + "\n",
        mode: 0o600
      }
    ];
    const lines = [
      "codex: config staged (lockdown: apps, plugins, memories, telemetry, updates off; history off)",
      "codex: hooks staged (PostToolUse pull hook, Stop journal guard)",
      "codex: the state directory is not a trusted project (its .codex config, hooks, and rules stay off)"
    ];
    if (shape.kind === "login") {
      files.push({ path: join(home, CODEX_AUTH_FILE), content: input.credential, mode: 0o600 });
      lines.push("codex: login file staged from the mind credential");
    } else {
      lines.push("codex: API-key credential (rides CODEX_API_KEY; nothing to relay)");
    }
    lines.push(
      input.telemetry
        ? `codex: telemetry exports to the porch relay (${input.telemetry.endpoint}): events, spans, metrics`
        : "codex: telemetry off (no chronicle door this wake)"
    );
    return {
      files,
      // Staged hooks are the chassis's own; Codex's hook trust is granted
      // in its TUI, which no wake has.
      args: ["--dangerously-bypass-hook-trust"],
      env: { CODEX_HOME: home },
      lines
    };
  },

  secretsIn(credential) {
    const shape = codexCredentialShape(credential);
    if (shape.kind === "apiKey") return [credential];
    const tokens = Object.entries(shape.login.tokens)
      .filter(([key, value]) => key !== "account_id" && typeof value === "string" && value.length > 0)
      .map(([, value]) => value as string);
    return [credential, ...tokens];
  },

  usageAccumulator() {
    return codexUsageAccumulator();
  },

  usageFrom(lines) {
    return codexUsageFrom(lines);
  },

  probe(model, credential) {
    return {
      command: "codex",
      // The container is the sandbox (spec 0010 §2), for the probe as for
      // the session: Codex's own sandbox needs bubblewrap the image does
      // not carry, and asking for it only earns a warning and a fallback.
      args: ["exec", PROBE_QUESTION, "-m", model, "--dangerously-bypass-approvals-and-sandbox", ...CODEX_INVARIANT_ARGS],
      env: credentialEnv(credential)
    };
  },

  // Codex has no fallback-model flag: the entrypoint's probe-then-fallback
  // covers an unavailable pinned model before the session (spec 0010 §4).
  session(prompt, model, credential) {
    return {
      command: "codex",
      args: ["exec", prompt, "-m", model, ...CODEX_INVARIANT_ARGS, ...CODEX_SESSION_ARGS],
      env: credentialEnv(credential)
    };
  }
};
