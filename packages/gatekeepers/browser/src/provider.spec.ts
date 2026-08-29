import { describe, expect, it } from "vitest";
import { pickPageTarget, resolveProvider } from "./provider.js";

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

describe("pickPageTarget", () => {
  it("prefers the attached, non-blank, newest page over a background first tab", () => {
    const { chosen, pages } = pickPageTarget([
      { targetId: "t1", type: "page", url: "about:blank", attached: false },
      { targetId: "t2", type: "page", url: "https://old.example", attached: true },
      { targetId: "t3", type: "page", url: "https://current.example", attached: true }
    ]);
    expect(chosen?.targetId).toBe("t3");
    // Every candidate page is reported, so an ambiguous pick is visible.
    expect(pages).toHaveLength(3);
  });

  it("lets an explicit URL-substring match override the heuristic", () => {
    const infos = [
      { targetId: "t2", type: "page", url: "https://old.example/checkout", attached: true },
      { targetId: "t3", type: "page", url: "https://current.example", attached: true }
    ];
    expect(pickPageTarget(infos, "old.example").chosen?.targetId).toBe("t2");
    expect(pickPageTarget(infos, "nowhere").chosen).toBeUndefined();
    expect(pickPageTarget(infos, "nowhere").pages).toHaveLength(2);
  });

  it("prefers attached over detached and real documents over blanks", () => {
    expect(
      pickPageTarget([
        { targetId: "a", type: "page", url: "https://x.example", attached: false },
        { targetId: "b", type: "page", url: "about:blank", attached: true }
      ]).chosen?.targetId
    ).toBe("b");
    expect(
      pickPageTarget([
        { targetId: "a", type: "page", url: "about:blank", attached: false },
        { targetId: "b", type: "page", url: "https://x.example", attached: false }
      ]).chosen?.targetId
    ).toBe("b");
  });

  it("keeps a driven blank page probe-eligible beside a non-blank background page", () => {
    const { chosen, contenders } = pickPageTarget([
      { targetId: "bg", type: "page", url: "https://background.example", attached: true },
      { targetId: "driven", type: "page", url: "about:blank", attached: true }
    ]);
    // The heuristic's guess may be the background page, but the probe
    // set must include the blank driven page so visibility can win.
    expect(chosen?.targetId).toBe("bg");
    expect(contenders.map(c => c.targetId).sort()).toEqual(["bg", "driven"]);
  });

  it("ignores non-page targets and falls back sensibly", () => {
    expect(
      pickPageTarget([
        { targetId: "w", type: "service_worker", url: "https://x.example" },
        { targetId: "p", type: "page", url: "https://x.example" }
      ]).chosen?.targetId
    ).toBe("p");
    expect(pickPageTarget([{ targetId: "w", type: "worker" }]).chosen?.targetId).toBe("w");
    expect(pickPageTarget([]).chosen).toBeUndefined();
  });
});
