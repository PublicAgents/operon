import { webMcpConfig, type WebMcpServer } from "./web-mcp.js";
import type { StagedMcpServer } from "./config.js";

/**
 * The one MCP config a wake hands its harness (spec 0008 §4).
 *
 * Everything the mind can reach through MCP is merged here: the browser
 * server of spec 0004, and every server the operator granted this agent.
 * It is written OUTSIDE the state repo and passed with --mcp-config,
 * rather than dropped as `.mcp.json` in the working tree, for two
 * reasons: the previous arrangement committed chassis config into the
 * agent's memory on every wake, and a file that names doors belongs
 * where `git add -A` cannot reach it.
 *
 * A remote server appears as a virtual host plus the wake nonce. The
 * container never learns the upstream URL or its credential; the
 * umbilical resolves the name, checks the grant, and attaches whatever
 * the upstream actually needs, outside the container.
 */

export interface McpEntry {
  type?: "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface MergedMcpConfig {
  mcpServers: Record<string, McpEntry>;
}

/** Where the local browser writes screenshots and downloads: outside the state repo. */
export const LOCAL_BROWSER_OUTPUT_DIR = "/tmp/operon-browser";
/** Google Chrome, as the image installs it. */
export const LOCAL_BROWSER_EXECUTABLE = "/usr/bin/google-chrome-stable";
/** The MCP server's name as the mind sees it. */
export const LOCAL_BROWSER_SERVER = "playwright";

/**
 * The local browser (spec 0004 §9): Chrome driven through the
 * Playwright MCP server, for UNAUTHENTICATED browsing through the
 * session's egress. The flags are chassis invariants: the profile
 * lives in memory and dies with the wake (no user-data-dir, no
 * storage state, no saved session), output lands outside the repo,
 * and every request rides the wake's forwarder when one runs.
 */
/**
 * The user agent a desktop Chrome on a Mac sends: the frozen platform
 * token Chrome has used since 2021 and a reduced version, so only the
 * major carries information. Headless Chrome would otherwise announce
 * itself as HeadlessChrome on Linux, which is a fingerprint, not a
 * fact worth broadcasting.
 */
export function macChromeUserAgent(chromeMajor: number): string {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

/** "Google Chrome 151.0.7922.173" -> 151; undefined when unreadable. */
export function chromeMajorFrom(versionLine: string): number | undefined {
  const match = /(\d+)\.\d+\.\d+\.\d+/.exec(versionLine);
  return match ? Number(match[1]) : undefined;
}

export interface LocalBrowserOptions {
  /** The wake's forwarder, when one runs. */
  proxyUrl?: string;
  /** The installed Chrome's major version, for the user agent; absent leaves Chrome's own. */
  chromeMajor?: number;
}

export function localBrowserEntry(options: LocalBrowserOptions = {}): McpEntry {
  const { proxyUrl, chromeMajor } = options;
  return {
    command: "playwright-mcp",
    args: [
      "--browser",
      "chrome",
      "--executable-path",
      LOCAL_BROWSER_EXECUTABLE,
      "--headless",
      "--isolated",
      "--no-sandbox",
      "--viewport-size",
      "1280x800",
      "--output-dir",
      LOCAL_BROWSER_OUTPUT_DIR,
      ...(chromeMajor !== undefined ? ["--user-agent", macChromeUserAgent(chromeMajor)] : []),
      ...(proxyUrl ? ["--proxy-server", proxyUrl] : [])
    ]
  };
}

export interface MergeOptions {
  porchUrl?: string;
  nonce?: string;
  /** Stage the local browser (spec 0004 §9). */
  localBrowser?: LocalBrowserOptions;
}

export function mergedMcpConfig(servers: StagedMcpServer[], options: MergeOptions = {}): MergedMcpConfig {
  const mcpServers: Record<string, McpEntry> = {};

  // The chassis's own servers first, so a granted server can never
  // displace what the specs promise; a name collision is refused below.
  if (options.porchUrl) {
    const web = webMcpConfig(options.porchUrl).mcpServers as Record<string, WebMcpServer>;
    for (const [name, entry] of Object.entries(web)) {
      mcpServers[name] = { command: entry.command, args: entry.args };
    }
  }
  if (options.localBrowser) {
    mcpServers[LOCAL_BROWSER_SERVER] = localBrowserEntry(options.localBrowser);
  }

  for (const server of servers) {
    if (server.name in mcpServers) {
      // A colony that names a server "browser" or "playwright" would
      // otherwise silently replace a chassis browser; the roster refuses
      // both names at check time (core RESERVED_MCP_NAMES), this is the
      // last line.
      throw new McpConfigError(`"${server.name}" collides with a chassis MCP server`);
    }
    if (server.type === "stdio") {
      mcpServers[server.name] = { command: server.command, args: server.args };
      continue;
    }
    mcpServers[server.name] = {
      type: "http",
      // The gatekeeper routes by the name in the path; the host is
      // virtual and resolves only inside this container.
      url: `http://${server.virtual}/mcp/${server.name}`,
      headers: {
        ...(options.nonce ? { authorization: `Bearer ${options.nonce}` } : {}),
        "x-operon-porch": "1"
      }
    };
  }
  return { mcpServers };
}

export class McpConfigError extends Error {
  override name = "McpConfigError";
}

export function mergedMcpConfigJson(servers: StagedMcpServer[], options: MergeOptions = {}): string {
  return JSON.stringify(mergedMcpConfig(servers, options), null, 2) + "\n";
}

/** One log line per staged server, so a quiet door is never ambiguous. */
export function mcpStagingLines(servers: StagedMcpServer[], hasBrowser: boolean, localBrowser = false): string[] {
  const lines: string[] = [];
  if (hasBrowser) lines.push("mcp: browser staged (the web door)");
  if (localBrowser) lines.push("mcp: playwright staged (the local browser: Chrome, unauthenticated, nothing kept between wakes)");
  for (const server of servers) {
    lines.push(
      server.type === "stdio"
        ? `mcp: ${server.name} staged (${server.command} ${server.args.join(" ")})`
        : `mcp: ${server.name} staged (through the umbilical)`
    );
  }
  if (lines.length === 0) lines.push("mcp: no servers configured");
  return lines;
}
