import { describe, expect, it } from "vitest";
import { percentEncode, sign, signatureBaseString } from "./oauth1.js";
import { boundReadParams, contentProblem, decidePost, dmContentProblem, dupKey, effectiveDailyCap, effectiveDmDailyCap, imageProblem, MIN_SPACING_MS, normalizeHandle, profileProblem, validateReadPath, xTokenVar } from "./policy.js";

/**
 * The signing implementation is verified against X's OWN documented
 * example ("Creating a signature" from the developer docs): fixed nonce,
 * timestamp, credentials, and form parameters, with the documented base
 * string and signature as the expected outputs. If this passes, the
 * crypto and the percent-encoding are right by construction.
 */
const DOC_CREDENTIALS = {
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"
};

const DOC_INPUT = {
  method: "post",
  url: "https://api.twitter.com/1.1/statuses/update.json",
  nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
  timestamp: "1318622958",
  extraParams: {
    status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    include_entities: "true"
  }
};

describe("oauth1 signing (X's documented example vector)", () => {
  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("Hello Ladies + Gentlemen, a signed OAuth request!")).toBe(
      "Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21"
    );
    expect(percentEncode("Dogs, Cats & Mice")).toBe("Dogs%2C%20Cats%20%26%20Mice");
  });

  it("builds the documented signature base string", () => {
    const base = signatureBaseString(DOC_INPUT, DOC_CREDENTIALS);
    expect(base).toBe(
      "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&" +
        "include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26" +
        "oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26" +
        "oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26" +
        "oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26" +
        "oauth_version%3D1.0%26" +
        "status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521"
    );
  });

  it("produces the documented signature", async () => {
    expect(await sign(DOC_INPUT, DOC_CREDENTIALS)).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });
});

describe("x policy", () => {
  it("maps agent ids to env names", () => {
    expect(xTokenVar("promoter")).toBe("X_TOKEN_PROMOTER");
  });

  it("bounds the daily cap by the hard ceiling", () => {
    expect(effectiveDailyCap(undefined)).toBe(4);
    expect(effectiveDailyCap("2")).toBe(2);
    expect(effectiveDailyCap("99")).toBe(10);
    expect(effectiveDailyCap("nope")).toBe(4);
  });

  it("refuses spam shapes pre-flight", () => {
    expect(contentProblem("a solid, valuable post")).toBeNull();
    expect(contentProblem("")).toBe("empty");
    expect(contentProblem("x".repeat(281))).toBe("too_long");
    expect(contentProblem("@a @b @c @d hi")).toBe("too_many_mentions");
    expect(contentProblem("#a #b #c #d hi")).toBe("too_many_hashtags");
  });

  it("bounds the DM cap and DM content separately (no spacing for replies)", () => {
    expect(effectiveDmDailyCap(undefined)).toBe(20);
    expect(effectiveDmDailyCap("99")).toBe(50);
    expect(dmContentProblem("thanks! here is the link")).toBeNull();
    expect(dmContentProblem("")).toBe("empty");
    expect(dmContentProblem("x".repeat(9501))).toBe("too_long");
  });

  it("keeps the bio disclosure structural and bounds profile fields", () => {
    const D = "AI agent";
    expect(profileProblem({ bio: "An autonomous AI agent promoting LiveVariant." }, D)).toBeNull();
    expect(profileProblem({ bio: "just a guy" }, D)).toBe("bio_missing_disclosure");
    expect(profileProblem({ bio: "x".repeat(161) }, D)).toBe("bio_too_long");
    expect(profileProblem({}, D)).toBe("empty");
    expect(profileProblem({ url: "https://prior.livevariant.ai" }, D)).toBeNull();
  });

  it("judges images by magic bytes and budget", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    expect(imageProblem(png, 1024)).toBeNull();
    expect(imageProblem(jpeg, 1024)).toBeNull();
    expect(imageProblem(new TextEncoder().encode("<svg xmlns='x'>"), 1024)).toBe("not_png_or_jpeg");
    const bigPng = new Uint8Array(2000);
    bigPng.set([0x89, 0x50, 0x4e, 0x47]);
    expect(imageProblem(bigPng, 100)).toBe("too_large");
  });

  it("normalizes handles and allowlists read paths", () => {
    expect(normalizeHandle("@Some_One1")).toBe("some_one1");
    expect(normalizeHandle("not a handle")).toBeNull();
    expect(validateReadPath("/2/tweets/search/recent")).toBe("/2/tweets/search/recent");
    expect(validateReadPath("2/users/me")).toBe("/2/users/me");
    expect(validateReadPath("/2/users/:self/mentions")).toBe("/2/users/:self/mentions");
    expect(validateReadPath("/2/tweets/search/all")).toBeNull();
    expect(validateReadPath("/2/users/me?x=1")).toBeNull();
    expect(validateReadPath("/1.1/account/update_profile.json")).toBeNull();
  });

  it("bounds read params and clamps max_results", () => {
    expect(boundReadParams({ query: "hello", max_results: "500" })).toEqual({
      query: "hello",
      max_results: "100"
    });
    expect(boundReadParams(undefined)).toEqual({});
    expect(boundReadParams({ ["x".repeat(50)]: "v" })).toBeNull();
    expect(boundReadParams({ q: "x".repeat(600) })).toBeNull();
  });

  it("enforces cap, spacing, and duplicates atomically comparable", () => {
    const base = {
      postedToday: 0,
      dailyCap: 4,
      lastPostAt: null,
      now: 10_000_000,
      recentKeys: [dupKey("An older post")],
      key: dupKey("A fresh post")
    };
    expect(decidePost(base)).toBeNull();
    expect(decidePost({ ...base, postedToday: 4 })).toBe("over_daily_cap");
    expect(decidePost({ ...base, lastPostAt: base.now - MIN_SPACING_MS + 1 })).toBe("too_soon");
    expect(decidePost({ ...base, key: dupKey("an  older POST") })).toBe("duplicate");
  });
});
