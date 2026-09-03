import { join } from "node:path";
import { chassisHooks, type HarnessAdapter } from "./types.js";

/**
 * The reference adapter: headless Claude Code on subscription auth.
 *
 * forbiddenEnv lists the variables that would silently change how the
 * harness authenticates or where it connects; the entrypoint refuses to
 * run if any of them are present (chassis spec 4.1, assertEnvClean).
 *
 * The adapter deliberately hardcodes no permission or autonomy settings:
 * how much the session may do unattended is an operator decision, supplied
 * per deployment through the harness extra-args mechanism (see config.ts),
 * the same way every other policy in this system is operator-owned. What
 * it does hardcode is the lockdown (spec 0010 §3): nothing attached to
 * the Claude account reaches the session, and nothing in the working
 * tree configures it.
 */

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

/** The settings keys that say the same in the file the harness reads. */
export const CLAUDE_LOCKDOWN_SETTINGS = {
  autoMemoryEnabled: false,
  disableClaudeAiConnectors: true
} as const;

/**
 * The working tree is data, not configuration (spec 0010 §2): only the
 * user settings the chassis staged load, and only the MCP servers the
 * chassis passed. Spec 0008 §6 left project servers loading; this
 * reverses it.
 */
export const CLAUDE_INVARIANT_ARGS = ["--setting-sources", "user", "--strict-mcp-config"];

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
    return { files, args, env: {}, lines };
  },

  secretsIn(credential) {
    return [credential];
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
        ...(fallbackModel ? ["--fallback-model", fallbackModel] : [])
      ],
      env: { ...CLAUDE_LOCKDOWN_ENV, CLAUDE_CODE_OAUTH_TOKEN: credential }
    };
  }
};
