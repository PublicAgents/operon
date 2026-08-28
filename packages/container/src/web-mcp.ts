/**
 * Staging the browser MCP server for the mind (spec 0004 section 2:
 * "MCP is the mind-side surface"). We write no bespoke browsing tools:
 * the harness gets the standard `chrome-devtools-mcp` pointed at the
 * porch's CDP relay, so the mind drives a real browser with the tools
 * its own ecosystem already provides, and every frame still passes the
 * relay's policy.
 *
 * The endpoint is loopback and carries no credential: the per-wake nonce
 * lives in the porch (root), and the CSRF header is what a browser page
 * cannot forge.
 */

export interface WebMcpServer {
  command: string;
  args: string[];
}

/** The default session a wake browses in when the mind names none. */
export const DEFAULT_SESSION = "default";

/**
 * The `.mcp.json` a harness reads. `porchUrl` is the loopback address
 * the entrypoint already hands the session (OPERON_PORCH).
 */
export function webMcpConfig(porchUrl: string, session = DEFAULT_SESSION): {
  mcpServers: Record<string, WebMcpServer>;
} {
  const endpoint = `${porchUrl.replace(/^http/, "ws").replace(/\/$/, "")}/web/session/${session}`;
  return {
    mcpServers: {
      browser: {
        command: "npx",
        args: [
          "-y",
          "chrome-devtools-mcp@latest",
          `--wsEndpoint=${endpoint}`,
          // The porch's CSRF fence: a real client sends it, page JS cannot.
          '--wsHeaders={"x-operon-porch":"1"}'
        ]
      }
    }
  };
}

/** Serialized form, for writing into the workspace. */
export function webMcpConfigJson(porchUrl: string, session = DEFAULT_SESSION): string {
  return JSON.stringify(webMcpConfig(porchUrl, session), null, 2) + "\n";
}
