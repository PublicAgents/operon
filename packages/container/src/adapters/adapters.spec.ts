import { describe, expect, it } from "vitest";
import { KNOWN_HARNESSES } from "@operon/core";
import {
  adapters,
  assertEnvClean,
  claudeCode,
  codex,
  getAdapter,
  UnknownHarnessError,
  EnvNotCleanError,
  CredentialShapeError
} from "./index.js";
import { CLAUDE_LOCKDOWN_ENV, claudeMcpConfigPath, claudeSettingsPath } from "./claude-code.js";
import { codexConfig, codexCredentialShape } from "./codex.js";
import type { MergedMcpConfig } from "../mcp-config.js";

const hooks = { pullHook: "node /opt/operon/pull-hook.js", journalGuard: "node /opt/operon/journal-guard.js" };
const mcp: MergedMcpConfig = {
  mcpServers: {
    browser: { command: "node", args: ["/opt/operon/web-mcp.js"] },
    "google-analytics": {
      type: "http",
      url: "http://mcp-google-analytics.operon.internal/mcp/google-analytics",
      headers: { authorization: "Bearer nonce-1", "x-operon-porch": "1" }
    }
  }
};
const login = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: "id.jwt", access_token: "access.jwt", refresh_token: "refresh-1", account_id: "acct-1" },
  last_refresh: "2026-09-01T00:00:00Z"
});

describe("getAdapter", () => {
  it("resolves known harnesses", () => {
    expect(getAdapter("claude-code")).toBe(claudeCode);
    expect(getAdapter("codex")).toBe(codex);
  });

  it("fails loudly on unknown harnesses", () => {
    expect(() => getAdapter("mystery")).toThrowError(UnknownHarnessError);
    expect(() => getAdapter("mystery")).toThrowError(/claude-code/);
  });

  it("implements exactly the harnesses the roster vocabulary names (spec 0010 §4)", () => {
    expect(Object.keys(adapters).sort()).toEqual([...KNOWN_HARNESSES].sort());
  });
});

describe("claude-code adapter", () => {
  it("builds a pinned session with fallback and injects its credential plus the lockdown", () => {
    const spec = claudeCode.session("do the wake", "claude-sonnet-5", "tok", "claude-haiku-4-5");
    expect(spec.command).toBe("claude");
    expect(spec.args).toEqual([
      "-p",
      "do the wake",
      "--model",
      "claude-sonnet-5",
      "--fallback-model",
      "claude-haiku-4-5",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose"
    ]);
    expect(spec.env).toEqual({ ...CLAUDE_LOCKDOWN_ENV, CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(spec.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(spec.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  it("omits the fallback flag when no fallback is pinned", () => {
    const spec = claudeCode.session("p", "claude-sonnet-5", "tok");
    expect(spec.args).not.toContain("--fallback-model");
  });

  it("probes with a model-identity question under the same lockdown and invariants", () => {
    const spec = claudeCode.probe("claude-sonnet-5", "tok");
    expect(spec.args).toContain("--model");
    expect(spec.args.join(" ")).toMatch(/model id/);
    expect(spec.args).toContain("--strict-mcp-config");
    expect(spec.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("stages user settings with the lockdown keys and the chassis hooks, and only user settings load", () => {
    const staged = claudeCode.stage({ home: "/home/mind", credential: "tok", hooks });
    expect(staged.files.map(file => file.path)).toEqual([claudeSettingsPath("/home/mind")]);
    const settings = JSON.parse(staged.files[0].content) as Record<string, unknown>;
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.disableClaudeAiConnectors).toBe(true);
    expect(JSON.stringify(settings.hooks)).toContain("pull-hook.js");
    expect(JSON.stringify(settings.hooks)).toContain("journal-guard.js");
    expect(staged.files[0].mode).toBe(0o600);
    expect(staged.args).toEqual(["--setting-sources", "user", "--strict-mcp-config"]);
    expect(staged.env).toEqual({});
  });

  it("stages the MCP config outside the state repo and points the session at it, strictly", () => {
    const staged = claudeCode.stage({ home: "/home/mind", credential: "tok", mcp, hooks });
    const path = claudeMcpConfigPath("/home/mind");
    expect(staged.files.map(file => file.path)).toContain(path);
    expect(JSON.parse(staged.files.find(file => file.path === path)?.content ?? "null")).toEqual(mcp);
    expect(staged.args).toEqual(["--setting-sources", "user", "--strict-mcp-config", "--mcp-config", path]);
  });

  it("denylists the token itself and has no file credential", () => {
    expect(claudeCode.secretsIn("tok")).toEqual(["tok"]);
    expect(claudeCode.credentialFile).toBeUndefined();
  });

  it("refuses an environment that could silently switch auth", () => {
    expect(() =>
      assertEnvClean(claudeCode, { ANTHROPIC_API_KEY: "sk-x" })
    ).toThrowError(EnvNotCleanError);
    expect(() =>
      assertEnvClean(claudeCode, { ANTHROPIC_BASE_URL: "https://elsewhere" })
    ).toThrowError(/ANTHROPIC_BASE_URL/);
    expect(() => assertEnvClean(claudeCode, { UNRELATED: "1" })).not.toThrow();
  });
});

describe("codex adapter (spec 0010 §4)", () => {
  it("tells a login file from an API key and refuses anything else by name", () => {
    expect(codexCredentialShape(login).kind).toBe("login");
    expect(codexCredentialShape("sk-proj-abc").kind).toBe("apiKey");
    expect(() => codexCredentialShape("")).toThrowError(CredentialShapeError);
    expect(() => codexCredentialShape("two words")).toThrowError(/mind_credential_malformed/);
    expect(() => codexCredentialShape("{not json")).toThrowError(/does not parse/);
    expect(() => codexCredentialShape('{"hello":1}')).toThrowError(/tokens table/);
  });

  it("stages its home under the mind's: config, hooks, and the login file, all 0600", () => {
    const staged = codex.stage({ home: "/home/mind", credential: login, hooks });
    expect(staged.files.map(file => file.path)).toEqual([
      "/home/mind/.codex/config.toml",
      "/home/mind/.codex/hooks.json",
      "/home/mind/.codex/auth.json"
    ]);
    for (const file of staged.files) expect(file.mode).toBe(0o600);
    expect(staged.files[2].content).toBe(login);
    expect(staged.env).toEqual({ CODEX_HOME: "/home/mind/.codex" });
    expect(staged.args).toEqual(["--dangerously-bypass-hook-trust"]);
    const hooksFile = JSON.parse(staged.files[1].content) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(hooksFile.hooks)).toEqual(["PostToolUse", "Stop"]);
    expect(JSON.stringify(hooksFile)).not.toContain('"matcher"');
  });

  it("turns off everything account-attached in the config, and never trusts the state dir", () => {
    const config = codex.stage({ home: "/home/mind", credential: login, hooks }).files[0].content;
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain("check_for_update_on_startup = false");
    expect(config).toContain("[history]\npersistence = \"none\"");
    expect(config).toContain("[analytics]\nenabled = false");
    expect(config).toContain("[feedback]\nenabled = false");
    expect(config).toContain("[otel]\nexporter = \"none\"");
    for (const feature of ["apps", "plugins", "remote_plugin", "tool_suggest", "recommended_plugins", "memories"]) {
      expect(config).toContain(`${feature} = false`);
    }
    expect(config).not.toContain("[projects");
    expect(config).not.toContain("mcp_servers");
  });

  it("renders the wake's MCP servers as codex tables with the nonce header", () => {
    const config = codex.stage({ home: "/home/mind", credential: login, mcp, hooks }).files[0].content;
    expect(config).toContain('[mcp_servers.browser]\ncommand = "node"\nargs = ["/opt/operon/web-mcp.js"]');
    expect(config).toContain(
      '[mcp_servers.google-analytics]\nurl = "http://mcp-google-analytics.operon.internal/mcp/google-analytics"'
    );
    expect(config).toContain('[mcp_servers.google-analytics.http_headers]\nauthorization = "Bearer nonce-1"\nx-operon-porch = "1"');
    expect(Object.keys(codexConfig(mcp).mcp_servers as object)).toEqual(["browser", "google-analytics"]);
  });

  it("stages no login file for an API key and rides it as CODEX_API_KEY", () => {
    const staged = codex.stage({ home: "/home/mind", credential: "sk-proj-abc", hooks });
    expect(staged.files.map(file => file.path)).not.toContain("/home/mind/.codex/auth.json");
    expect(codex.session("p", "gpt-5.5", "sk-proj-abc").env).toEqual({ CODEX_API_KEY: "sk-proj-abc" });
    expect(codex.probe("gpt-5.5", "sk-proj-abc").env).toEqual({ CODEX_API_KEY: "sk-proj-abc" });
    expect(codex.credentialFile?.("sk-proj-abc")).toBeUndefined();
  });

  it("runs codex exec unattended with the pinned model, no trust, no persistence, and no fallback flag", () => {
    const spec = codex.session("do the wake", "gpt-5.5", login, "gpt-5.5-mini");
    expect(spec.command).toBe("codex");
    expect(spec.args).toEqual([
      "exec",
      "do the wake",
      "-m",
      "gpt-5.5",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json"
    ]);
    expect(spec.env).toEqual({});
    const probe = codex.probe("gpt-5.5", login);
    expect(probe.args).toContain("--sandbox");
    expect(probe.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(probe.args).not.toContain("--json");
    expect(probe.args.join(" ")).toMatch(/model id/);
  });

  it("denylists every token in a login file and names the file to relay", () => {
    expect(codex.secretsIn(login)).toEqual([login, "id.jwt", "access.jwt", "refresh-1"]);
    expect(codex.secretsIn("sk-proj-abc")).toEqual(["sk-proj-abc"]);
    expect(codex.credentialFile?.(login)).toBe(".codex/auth.json");
  });

  it("refuses an environment that would switch its auth or home", () => {
    expect(() => assertEnvClean(codex, { OPENAI_API_KEY: "sk" })).toThrowError(EnvNotCleanError);
    expect(() => assertEnvClean(codex, { CODEX_API_KEY: "sk" })).toThrowError(/CODEX_API_KEY/);
    expect(() => assertEnvClean(codex, { CODEX_HOME: "/root/.codex" })).toThrowError(/CODEX_HOME/);
  });
});
