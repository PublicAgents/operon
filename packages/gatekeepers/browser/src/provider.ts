/**
 * The upstream CDP provider as configuration (spec 0004: the web door
 * is a policy point over PLAIN CDP; who runs the browser is a
 * deployment choice). Cloudflare Browser Run is the default provider,
 * built from CF_ACCOUNT_ID + BROWSER_RUN_TOKEN; any other CDP endpoint
 * (Browserbase, browserless, self-hosted Chrome) plugs in via
 * WEB_CDP_ENDPOINT (+ optional WEB_CDP_TOKEN bearer, or credentials in
 * the URL itself) with NO code change. Everything downstream of the
 * dial (relay, policy, identity persistence, metering, screenshots) is
 * provider-neutral CDP; only the vendor live-view command is
 * capability-gated per provider.
 *
 * Multiple providers per deployment (per agent or per session) are a
 * Phase 2 concern: provider selection then becomes registry data, and
 * this resolver grows a lookup instead of a different shape.
 */

export interface ProviderEnv {
  CF_ACCOUNT_ID?: string;
  BROWSER_RUN_TOKEN?: string;
  /**
   * Full wss/https CDP endpoint of a non-default provider. May carry
   * credentials as URL userinfo (wss://user:pass@host); those become the
   * dial's Basic authorization and never travel in the URL.
   */
  WEB_CDP_ENDPOINT?: string;
  /** Bearer for WEB_CDP_ENDPOINT; omitted when the URL itself carries auth. */
  WEB_CDP_TOKEN?: string;
  /** Display name for ledger rows; "cloudflare" enables vendor live view. */
  WEB_CDP_PROVIDER?: string;
}

export interface CdpProvider {
  name: string;
  /** https form (the Workers fetch-upgrade dial wants http(s)). */
  url: string;
  headers: Record<string, string>;
  /** Whether the vendor live-view command (Cloudflare.getLiveView) works. */
  liveView: boolean;
}

export interface TargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
  attached?: boolean;
}

/**
 * The page to observe, from a Target.getTargets enumeration. CDP's
 * browser endpoint carries no focus signal, so certainty is not
 * available; the contract is therefore: an explicit `match` (URL
 * substring, the operator's choice) wins outright, and WITHOUT one the
 * heuristic prefers attached pages over detached, real documents over
 * blank/internal ones, newest among equals, while the CALLER reports
 * every candidate page back to the operator so an ambiguous pick is
 * visible and correctable rather than silently wrong.
 */
export function pickPageTarget(
  infos: readonly TargetInfo[],
  match?: string
): { chosen?: TargetInfo; pages: TargetInfo[]; contenders: TargetInfo[] } {
  const pages = infos.filter(info => info.type === "page" && info.targetId);
  if (match) {
    const wanted = pages.filter(info => (info.url ?? "").includes(match));
    // An explicit match is the operator's word: everything inside it is
    // probe-eligible, nothing outside competes.
    if (wanted.length > 0) return { chosen: heuristic(wanted), pages, contenders: probeSet(wanted) };
    return { chosen: undefined, pages, contenders: [] };
  }
  if (pages.length === 0) {
    const fallback = infos.find(info => info.targetId);
    return { chosen: fallback, pages, contenders: fallback ? [fallback] : [] };
  }
  return { chosen: heuristic(pages), pages, contenders: probeSet(pages) };
}

function pageScore(info: TargetInfo): number {
  const blank = !info.url || info.url === "about:blank" || info.url.startsWith("devtools://");
  return (info.attached ? 2 : 0) + (blank ? 0 : 1);
}

/**
 * The pages worth ASKING about: every attached page (the driven tab may
 * currently be blank or internal, so blankness must not disqualify it
 * from the visibility probe), or every page when none is attached.
 * Scoring is only the fallback for when no document answers visible.
 */
function probeSet(pages: readonly TargetInfo[]): TargetInfo[] {
  const attached = pages.filter(info => info.attached);
  return attached.length > 0 ? attached : [...pages];
}

function heuristic(pages: readonly TargetInfo[]): TargetInfo {
  let best = pages[0];
  let bestScore = pageScore(best);
  for (const candidate of pages.slice(1)) {
    const candidateScore = pageScore(candidate);
    // >= so later (newer) targets win ties, pending the visibility probe.
    if (candidateScore >= bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
}

/** btoa over UTF-8 bytes: a password is not limited to Latin-1. */
function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function resolveProvider(env: ProviderEnv): CdpProvider | { error: string } {
  if (env.WEB_CDP_ENDPOINT) {
    let parsed: URL;
    try {
      parsed = new URL(env.WEB_CDP_ENDPOINT);
    } catch {
      return { error: "web_cdp_endpoint_invalid" };
    }
    if (!/^(wss|https):$/.test(parsed.protocol)) {
      return { error: "web_cdp_endpoint_insecure" };
    }
    const name = env.WEB_CDP_PROVIDER ?? "custom";
    // Credentials in the URL (wss://user:pass@host) travel as a Basic
    // authorization header on the dial, never in the URL: userinfo is
    // not something a fetch reliably presents as authentication, and a
    // dial URL is something logs and errors may quote. Two credentials
    // at once is a misconfiguration, refused by name rather than
    // resolved by guess.
    const userinfo = parsed.username !== "" || parsed.password !== "";
    if (userinfo && env.WEB_CDP_TOKEN) return { error: "web_cdp_auth_ambiguous" };
    let headers: Record<string, string> = {};
    if (userinfo) {
      let user: string;
      let pass: string;
      try {
        user = decodeURIComponent(parsed.username);
        pass = decodeURIComponent(parsed.password);
      } catch {
        return { error: "web_cdp_endpoint_invalid" };
      }
      headers = { authorization: `Basic ${base64Utf8(`${user}:${pass}`)}` };
      parsed.username = "";
      parsed.password = "";
    } else if (env.WEB_CDP_TOKEN) {
      headers = { authorization: `Bearer ${env.WEB_CDP_TOKEN}` };
    }
    return {
      name,
      url: parsed.href.replace(/^wss:/, "https:"),
      headers,
      liveView: name === "cloudflare"
    };
  }
  if (env.CF_ACCOUNT_ID && env.BROWSER_RUN_TOKEN) {
    return {
      name: "cloudflare",
      url:
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
        `/browser-rendering/devtools/browser?keep_alive=600000&recording=true`,
      headers: { authorization: `Bearer ${env.BROWSER_RUN_TOKEN}` },
      liveView: true
    };
  }
  return { error: "web_cdp_unconfigured" };
}
