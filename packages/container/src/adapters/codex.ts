import { AdapterNotImplementedError, type HarnessAdapter } from "./types.js";

/**
 * Codex CLI adapter: second in the harness order (chassis spec, decision
 * 1a), not implemented yet. It exists so a roster naming "codex" fails with
 * a named error instead of an unknown-harness surprise, and to hold the
 * notes that matter when it lands: Codex's subscription auth lives in a
 * login file rather than an env var, so the credential injection story
 * differs from claude-code and must be designed, not assumed.
 */
export const codex: HarnessAdapter = {
  id: "codex",
  forbiddenEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  credentialEnv: "OPENAI_API_KEY",

  probe(): never {
    throw new AdapterNotImplementedError("codex");
  },

  session(): never {
    throw new AdapterNotImplementedError("codex");
  }
};
