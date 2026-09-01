/**
 * The paths this door answers (spec 0008 §4).
 *
 * The container's MCP config addresses every server as /mcp/<name>, the
 * same shape the generic proxy routes on, because the container is
 * deliberately not told which kind of server it holds. A bespoke Worker
 * therefore accepts its own name on the path, and bare /mcp for direct
 * callers. This is the contract the first hand-run wake found broken:
 * the harness reported the server "failed" because this Worker answered
 * 404 to /mcp/google-analytics.
 *
 * Its own module so the contract can be tested without the Workers
 * runtime the rest of the door needs.
 */
export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || /^\/mcp\/[a-z0-9][a-z0-9-]*$/.test(pathname);
}
