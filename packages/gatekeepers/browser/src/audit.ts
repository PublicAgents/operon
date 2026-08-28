/**
 * The relay's audit taps (spec 0004 section 3), pure and unit-tested:
 * which CDP frames become ledger rows. The relay stores no raw frames;
 * these are the derived events, and the Browser Run recording is the
 * full-fidelity replay.
 */

export interface AuditEvent {
  kind: "navigation" | "download";
  url: string;
}

/** Cheap pre-filter so the relay does not JSON.parse every frame. */
const INTERESTING = /"Page\.frameNavigated"|"Browser\.downloadWillBegin"|"Page\.downloadWillBegin"/;

/**
 * Parse one upstream CDP frame into an audit event, or null. Only
 * TOP-frame navigations count (subframes are ads and embeds, and the
 * recording has them anyway).
 */
export function auditEvent(frame: string): AuditEvent | null {
  if (!INTERESTING.test(frame)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return null;
  }
  const message = parsed as {
    method?: string;
    params?: {
      frame?: { url?: string; parentId?: string };
      url?: string;
    };
  };
  if (message?.method === "Page.frameNavigated") {
    const frameInfo = message.params?.frame;
    if (frameInfo?.url && !frameInfo.parentId) return { kind: "navigation", url: frameInfo.url };
    return null;
  }
  if (message?.method === "Browser.downloadWillBegin" || message?.method === "Page.downloadWillBegin") {
    const url = message.params?.url;
    if (typeof url === "string") return { kind: "download", url };
  }
  return null;
}

/** A session name: lowercase, digits, dashes; the DO key half. */
export const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** "/web/session/research" -> "research"; null for anything else. */
export function sessionNameFromPath(pathname: string): string | null {
  const prefix = "/web/session/";
  if (!pathname.startsWith(prefix)) return null;
  const name = pathname.slice(prefix.length);
  return SESSION_NAME.test(name) ? name : null;
}

/** The upstream Browser Run CDP endpoint for an account. */
export function upstreamEndpoint(accountId: string): string {
  return (
    `wss://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/browser-rendering/devtools/browser?keep_alive=600000&recording=true`
  );
}
