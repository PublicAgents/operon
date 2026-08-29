/**
 * The upstream CDP provider as configuration (spec 0004: the web door
 * is a policy point over PLAIN CDP; who runs the browser is a
 * deployment choice). Cloudflare Browser Run is the default provider,
 * built from CF_ACCOUNT_ID + BROWSER_RUN_TOKEN; any other CDP endpoint
 * (Browserbase, browserless, self-hosted Chrome) plugs in via
 * WEB_CDP_ENDPOINT (+ optional WEB_CDP_TOKEN bearer) with NO code
 * change. Everything downstream of the dial (relay, policy, identity
 * persistence, metering, screenshots) is provider-neutral CDP; only
 * the vendor live-view command is capability-gated per provider.
 *
 * Multiple providers per deployment (per agent or per session) are a
 * Phase 2 concern: provider selection then becomes registry data, and
 * this resolver grows a lookup instead of a different shape.
 */

export interface ProviderEnv {
  CF_ACCOUNT_ID?: string;
  BROWSER_RUN_TOKEN?: string;
  /** Full ws(s)/http(s) CDP endpoint of a non-default provider. */
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
    return {
      name,
      url: parsed.href.replace(/^wss:/, "https:"),
      headers: env.WEB_CDP_TOKEN ? { authorization: `Bearer ${env.WEB_CDP_TOKEN}` } : {},
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
