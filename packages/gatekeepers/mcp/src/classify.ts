/**
 * The trust boundary (spec 0008 §2). NOTHING outside this file reads a
 * tool's annotations, so there is exactly one answer in the system to
 * "may this agent call this tool", and one place to change it.
 *
 * The rule, in full:
 *
 *   A tool is a READ iff `readOnlyHint === true`. Strict equality: an
 *   unannotated tool is a write, because most servers publish no
 *   annotations at all and "unknown" must not read as "safe".
 *
 *   A read passes when the upstream is VETTED, meaning an administrator
 *   put it behind the deployment's portal. A read from a BYO upstream
 *   does not pass on the server's word alone.
 *
 *   Everything else needs the operator to have pinned the tool by name
 *   in the manifest. A pin is a human decision recorded in a reviewable
 *   file, which is the only thing that can authorize a write here.
 *
 * No annotation an upstream publishes can widen access; annotations can
 * only narrow the pin requirement, and only on a vetted upstream.
 */

export type ServerTrust = "byo" | "vetted";

export interface UpstreamTool {
  name: string;
  /** The upstream's own title, description and schemas, passed to the mind untouched. */
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: unknown };
}

export type ToolVerdict =
  | { allowed: true; mode: "read" | "pinned" }
  | { allowed: false; code: string; detail: string };

/** Tools that change which upstreams a session can reach are never grantable. */
export const PORTAL_CONTROL_PREFIX = "portal_";

export function isRead(tool: UpstreamTool): boolean {
  return tool.annotations?.readOnlyHint === true;
}

export function classify(
  tool: UpstreamTool,
  input: { trust: ServerTrust; pinned: string[]; server: string }
): ToolVerdict {
  if (tool.name.startsWith(PORTAL_CONTROL_PREFIX)) {
    return {
      allowed: false,
      code: "mcp_tool_needs_grant",
      detail: `${tool.name} is never grantable: portal_* tools change which servers a session reaches`
    };
  }
  if (input.pinned.includes(tool.name)) return { allowed: true, mode: "pinned" };
  if (input.trust === "vetted" && isRead(tool)) return { allowed: true, mode: "read" };
  const why =
    input.trust === "vetted"
      ? "it is not declared read-only"
      : "this upstream is not administrator-vetted, so its own annotations do not authorize a call";
  return {
    allowed: false,
    code: "mcp_tool_needs_grant",
    detail: `${tool.name} is not granted: ${why}. Pin it under mcp.${input.server}.tools in the manifest.`
  };
}

/**
 * Which upstream server a portal tool belongs to, by name prefix.
 *
 * Prefix grammars are ambiguous when one server id prefixes another, so
 * the LONGEST known id wins: with servers `foo` and `foo_bar` declared,
 * `foo_bar_create` belongs to `foo_bar` and can never ride a grant for
 * `foo`. The manifest also refuses that pair outright; this is the
 * call-time half of the same rule, for ids the portal knows but the
 * manifest did not name.
 */
export function ownerOf(toolName: string, knownServers: string[]): string | null {
  let best: string | null = null;
  for (const server of knownServers) {
    if (!toolName.startsWith(`${server}_`)) continue;
    if (best === null || server.length > best.length) best = server;
  }
  return best;
}

/** A portal grant covers exactly the tools of ONE upstream server. */
export function inPortalScope(
  toolName: string,
  server: string,
  knownServers: string[]
): boolean {
  return ownerOf(toolName, knownServers.includes(server) ? knownServers : [...knownServers, server]) === server;
}
