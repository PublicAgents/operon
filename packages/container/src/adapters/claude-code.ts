import type { HarnessAdapter } from "./types.js";

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
 * the same way every other policy in this system is operator-owned.
 */
export const claudeCode: HarnessAdapter = {
  id: "claude-code",
  forbiddenEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  credentialEnv: "CLAUDE_CODE_OAUTH_TOKEN",

  mcpConfigArgs(path) {
    // Not --strict-mcp-config: the repo may carry the mind's own
    // project servers, which are in its trust domain already, and
    // strictness would silently drop them.
    return ["--mcp-config", path];
  },

  probe(model, credential) {
    return {
      command: "claude",
      args: [
        "-p",
        "Reply with only the exact model id you are running as, nothing else.",
        "--model",
        model
      ],
      env: { CLAUDE_CODE_OAUTH_TOKEN: credential }
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
      env: { CLAUDE_CODE_OAUTH_TOKEN: credential }
    };
  }
};
