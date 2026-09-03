import { join } from "node:path";
import { chassisHooks, type HarnessAdapter } from "./types.js";
import { claudeUsageAccumulator, claudeUsageFrom } from "../usage.js";

/**
 * The reference adapter: headless Claude Code on subscription auth.
 *
 * forbiddenEnv lists the variables that would silently change how the
 * harness authenticates or where it connects; the entrypoint refuses to
 * run if any of them are present (chassis spec 4.1, assertEnvClean).
 *
 * The session runs unattended by construction (spec 0010 §2): the
 * permission bypass and the streamed output format are part of the
 * command, not an operator setting, because a headless wake that may
 * stop to ask is not a wake. HARNESS_EXTRA_ARGS remains for genuine
 * extras (an effort level, a flag a new version grows), empty by
 * default. The lockdown (spec 0010 §3) is hardcoded too: nothing
 * attached to the Claude account reaches the session, and nothing in
 * the working tree configures it.
 */

/** Unattended, streamed: the container is the sandbox; the JSONL stream is the transcript. */
export const CLAUDE_SESSION_ARGS = [
  "--permission-mode",
  "bypassPermissions",
  "--output-format",
  "stream-json",
  "--verbose"
];

/** Everything account-attached, off (spec 0010 §3); repeated in the image's managed settings. */
export const CLAUDE_LOCKDOWN_ENV: Record<string, string> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
};

/**
 * The settings keys that say the same in the file the harness reads.
 *
 * switchModelsOnFlag is the one that is TRUE on purpose: when a safety
 * classifier flags a request, the harness either switches to its fixed
 * fallback and carries on, or, with this false, PAUSES the session and
 * asks a human which to do. A wake has no human at the keyboard, so a
 * pause is a wake that hangs until its wall clock kills it. The switch
 * is announced in the wake's usage line (spec 0011) either way, so the
 * operator learns of it without the session stopping.
 */
export const CLAUDE_LOCKDOWN_SETTINGS = {
  autoMemoryEnabled: false,
  disableClaudeAiConnectors: true,
  switchModelsOnFlag: true
} as const;

/**
 * The working tree is data, not configuration (spec 0010 §2): only the
 * user settings the chassis staged load, and only the MCP servers the
 * chassis passed. Spec 0008 §6 left project servers loading; this
 * reverses it.
 */
export const CLAUDE_INVARIANT_ARGS = ["--setting-sources", "user", "--strict-mcp-config"];

/**
 * Telemetry to the chassis, never to the provider (spec 0011 §2): OTLP
 * over HTTP/JSON to the porch's relay, spans included (the beta flag),
 * short export intervals so a wake's tail is not lost, account and
 * content attributes off. The porch header is the only credential-like
 * thing here, and it is not one.
 */
export function claudeTelemetryEnv(endpoint: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: "x-operon-porch=1",
    OTEL_METRIC_EXPORT_INTERVAL: "15000",
    OTEL_LOGS_EXPORT_INTERVAL: "5000",
    OTEL_TRACES_EXPORT_INTERVAL: "5000",
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOG_TOOL_DETAILS: "0"
  };
}

export function claudeSettingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

export function claudeMcpConfigPath(home: string): string {
  return join(home, ".operon", "mcp.json");
}

export const claudeCode: HarnessAdapter = {
  id: "claude-code",
  forbiddenEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  lockdownEnv: CLAUDE_LOCKDOWN_ENV,

  stage(input) {
    const files = [
      {
        path: claudeSettingsPath(input.home),
        content:
          JSON.stringify({ ...CLAUDE_LOCKDOWN_SETTINGS, hooks: chassisHooks(input.hooks, "*") }, null, 2) + "\n",
        mode: 0o600
      }
    ];
    const args = [...CLAUDE_INVARIANT_ARGS];
    const lines = [
      "claude-code: user settings staged (lockdown, PostToolUse pull hook, Stop journal guard)",
      "claude-code: project settings and project MCP servers do not load (--setting-sources user, --strict-mcp-config)"
    ];
    if (input.mcp) {
      const path = claudeMcpConfigPath(input.home);
      files.push({ path, content: JSON.stringify(input.mcp, null, 2) + "\n", mode: 0o600 });
      args.push("--mcp-config", path);
    }
    const env = input.telemetry ? claudeTelemetryEnv(input.telemetry.endpoint) : {};
    lines.push(
      input.telemetry
        ? `claude-code: telemetry exports to the porch relay (${input.telemetry.endpoint}), spans included`
        : "claude-code: telemetry off (no chronicle door this wake)"
    );
    return { files, args, env, lines };
  },

  secretsIn(credential) {
    return [credential];
  },

  usageAccumulator() {
    return claudeUsageAccumulator();
  },

  usageFrom(lines) {
    return claudeUsageFrom(lines);
  },

  probe(model, credential) {
    return {
      command: "claude",
      args: [
        "-p",
        "Reply with only the exact model id you are running as, nothing else.",
        "--model",
        model,
        ...CLAUDE_INVARIANT_ARGS
      ],
      env: { ...CLAUDE_LOCKDOWN_ENV, CLAUDE_CODE_OAUTH_TOKEN: credential }
    };
  },

  session(prompt, model, credential, fallbackModel) {
    return {
      command: "claude",
      args: [
        "-p",
        prompt,
        "--model",
        model,
        ...(fallbackModel ? ["--fallback-model", fallbackModel] : []),
        ...CLAUDE_SESSION_ARGS
      ],
      env: { ...CLAUDE_LOCKDOWN_ENV, CLAUDE_CODE_OAUTH_TOKEN: credential }
    };
  }
};
