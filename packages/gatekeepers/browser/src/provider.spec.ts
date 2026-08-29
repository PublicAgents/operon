import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider.js";

describe("resolveProvider", () => {
  it("defaults to Cloudflare Browser Run with recording and live view", () => {
    const provider = resolveProvider({ CF_ACCOUNT_ID: "acc1", BROWSER_RUN_TOKEN: "tok" });
    expect(provider).toMatchObject({ name: "cloudflare", liveView: true });
    if ("url" in provider) {
      expect(provider.url).toContain("/accounts/acc1/browser-rendering/");
      expect(provider.url).toContain("recording=true");
      expect(provider.headers).toEqual({ authorization: "Bearer tok" });
    }
  });

  it("uses a configured endpoint verbatim, wss translated for the dial", () => {
    const provider = resolveProvider({
      WEB_CDP_ENDPOINT: "wss://chrome.example.test/cdp?apikey=inline",
      WEB_CDP_PROVIDER: "selfhosted"
    });
    expect(provider).toMatchObject({
      name: "selfhosted",
      url: "https://chrome.example.test/cdp?apikey=inline",
      headers: {},
      liveView: false
    });
  });

  it("attaches the bearer for a token-authenticated provider and gates live view on the name", () => {
    const custom = resolveProvider({
      WEB_CDP_ENDPOINT: "wss://provider.example.test/",
      WEB_CDP_TOKEN: "secret"
    });
    expect(custom).toMatchObject({
      name: "custom",
      headers: { authorization: "Bearer secret" },
      liveView: false
    });
    const namedCf = resolveProvider({
      WEB_CDP_ENDPOINT: "wss://gateway.example.test/cf",
      WEB_CDP_PROVIDER: "cloudflare"
    });
    expect(namedCf).toMatchObject({ liveView: true });
  });

  it("fails closed on missing or insecure configuration", () => {
    expect(resolveProvider({})).toEqual({ error: "web_cdp_unconfigured" });
    expect(resolveProvider({ WEB_CDP_ENDPOINT: "not a url" })).toEqual({
      error: "web_cdp_endpoint_invalid"
    });
    expect(resolveProvider({ WEB_CDP_ENDPOINT: "ws://plain.example.test/" })).toEqual({
      error: "web_cdp_endpoint_insecure"
    });
  });
});
