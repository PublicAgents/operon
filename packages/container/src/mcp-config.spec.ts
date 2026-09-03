import { describe, expect, it } from "vitest";
import { LOCAL_BROWSER_OUTPUT_DIR, McpConfigError, mcpStagingLines, mergedMcpConfig } from "./mcp-config.js";
import type { StagedMcpServer } from "./config.js";

const PORCH = "http://127.0.0.1:41414";
const NONCE = "wake-nonce-0001";

const remote: StagedMcpServer = {
  name: "google-analytics",
  type: "http",
  virtual: "mcp-google-analytics.operon.internal"
};
const local: StagedMcpServer = {
  name: "somelocal",
  type: "stdio",
  command: "npx",
  args: ["-y", "some-mcp@1.2.3"]
};

describe("mergedMcpConfig", () => {
  it("keeps the browser door and the granted servers in one file", () => {
    const config = mergedMcpConfig([remote, local], { porchUrl: PORCH, nonce: NONCE });
    expect(Object.keys(config.mcpServers)).toEqual(["browser", "google-analytics", "somelocal"]);
    expect(config.mcpServers.browser.command).toBe("npx");
  });

  it("gives a remote server a virtual host and the wake nonce, and nothing else", () => {
    const config = mergedMcpConfig([remote], { porchUrl: PORCH, nonce: NONCE });
    const entry = config.mcpServers["google-analytics"];
    expect(entry).toEqual({
      type: "http",
      url: "http://mcp-google-analytics.operon.internal/mcp/google-analytics",
      headers: { authorization: `Bearer ${NONCE}`, "x-operon-porch": "1" }
    });
    // No upstream URL and no upstream credential are knowable here.
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("analyticsdata");
  });

  it("passes a stdio server through verbatim", () => {
    const config = mergedMcpConfig([local]);
    expect(config.mcpServers.somelocal).toEqual({
      command: "npx",
      args: ["-y", "some-mcp@1.2.3"]
    });
  });

  it("stages the granted servers even when the web door is closed", () => {
    // MCP access must not depend on browser access: an agent with a
    // grant and no web door still carries the wake nonce.
    const config = mergedMcpConfig([remote], { nonce: NONCE });
    expect(Object.keys(config.mcpServers)).toEqual(["google-analytics"]);
    expect(config.mcpServers["google-analytics"].headers?.authorization).toBe(`Bearer ${NONCE}`);
  });

  it("refuses a colony server that would displace a chassis door", () => {
    // A server named "browser" would otherwise quietly replace the web
    // door spec 0004 promises.
    const collision: StagedMcpServer = {
      name: "browser",
      type: "http",
      virtual: "mcp-browser.operon.internal"
    };
    expect(() => mergedMcpConfig([collision], { porchUrl: PORCH })).toThrow(McpConfigError);
  });
});

describe("the local browser (spec 0004 §9)", () => {
  it("stages Chrome through the Playwright server, isolated, headless, outside the repo, through the forwarder", () => {
    const config = mergedMcpConfig([], { porchUrl: PORCH, localBrowser: { proxyUrl: "http://127.0.0.1:41415" } });
    const entry = config.mcpServers.playwright;
    expect(entry.command).toBe("playwright-mcp");
    expect(entry.args).toEqual([
      "--browser",
      "chrome",
      "--executable-path",
      "/usr/bin/google-chrome-stable",
      "--headless",
      "--isolated",
      "--no-sandbox",
      "--viewport-size",
      "1280x800",
      "--output-dir",
      LOCAL_BROWSER_OUTPUT_DIR,
      "--proxy-server",
      "http://127.0.0.1:41415"
    ]);
    expect(entry.args.join(" ")).not.toMatch(/user-data-dir|storage-state|save-session/);
    expect(config.mcpServers.browser).toBeDefined();
  });

  it("goes direct without a forwarder, is absent unless asked, and reserves its name", () => {
    expect(mergedMcpConfig([], { localBrowser: {} }).mcpServers.playwright.args).not.toContain("--proxy-server");
    expect(mergedMcpConfig([], { porchUrl: PORCH }).mcpServers.playwright).toBeUndefined();
    const clash: StagedMcpServer = { name: "playwright", type: "stdio", command: "npx", args: ["-y", "x@1.0.0"] };
    expect(() => mergedMcpConfig([clash], { localBrowser: {} })).toThrowError(McpConfigError);
    expect(mcpStagingLines([], false, true)).toEqual([
      "mcp: playwright staged (the local browser: Chrome, unauthenticated, nothing kept between wakes)"
    ]);
  });
});

describe("mcpStagingLines", () => {
  it("says something for every wake, so a quiet door is never ambiguous", () => {
    // Silence would read the same as "the door is not wired", which is
    // a failure mode this chassis has already paid for.
    expect(mcpStagingLines([], false)).toEqual(["mcp: no servers configured"]);
    expect(mcpStagingLines([], true)).toEqual(["mcp: browser staged (the web door)"]);
  });

  it("names each staged server and how it is reached", () => {
    const lines = mcpStagingLines([remote, local], true);
    expect(lines).toEqual([
      "mcp: browser staged (the web door)",
      "mcp: google-analytics staged (through the umbilical)",
      "mcp: somelocal staged (npx -y some-mcp@1.2.3)"
    ]);
  });
});
