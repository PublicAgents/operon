import { describe, expect, it } from "vitest";
import { applyFill, cdpDecision, hostMatches, originOnDomain, redactCredentials } from "./cdp-policy.js";

const CREDS = {
  credentials: { github: { value: "p@ss'w\"o\\rd${x}", domains: ["github.com"] } }
};

describe("cdp relay policy", () => {
  it("blocks cookie export methods with a CDP error for the client", () => {
    const decision = cdpDecision('{"id":7,"method":"Network.getAllCookies","sessionId":"S1"}');
    expect(decision.action).toBe("block");
    if (decision.action !== "block") return;
    const parsed = JSON.parse(decision.response);
    expect(parsed.id).toBe(7);
    expect(parsed.error.message).toContain("Network.getAllCookies");
    expect(parsed.sessionId).toBe("S1");
  });

  it("blocks every WebAuthn method (the DO owns the authenticator)", () => {
    expect(cdpDecision('{"id":1,"method":"WebAuthn.getCredentials"}').action).toBe("block");
    expect(cdpDecision('{"id":2,"method":"WebAuthn.addVirtualAuthenticator"}').action).toBe("block");
  });

  it("blocks navigation to a denied origin", () => {
    const policy = { originDenylist: ["evil.example", "*.tracker.net"] };
    const denied = cdpDecision('{"id":1,"method":"Page.navigate","params":{"url":"https://evil.example/x"}}', policy);
    expect(denied.action).toBe("block");
    const sub = cdpDecision('{"id":2,"method":"Page.navigate","params":{"url":"https://a.tracker.net/"}}', policy);
    expect(sub.action).toBe("block");
    const fine = cdpDecision('{"id":3,"method":"Page.navigate","params":{"url":"https://example.com/"}}', policy);
    expect(fine.action).toBe("forward");
  });

  it("forwards ordinary automation and non-command frames", () => {
    expect(cdpDecision('{"id":1,"method":"Page.navigate","params":{"url":"https://x.dev"}}').action).toBe("forward");
    expect(cdpDecision('{"id":5,"result":{}}').action).toBe("forward");
    expect(cdpDecision("not json").action).toBe("forward");
  });

  it("defers a placeholder fill until the target origin is known", () => {
    const decision = cdpDecision(
      '{"id":9,"method":"Input.insertText","params":{"text":"{{vault:web/github}}"}}',
      CREDS
    );
    expect(decision.action).toBe("resolve-origin");
    if (decision.action !== "resolve-origin") return;
    expect(decision.credential).toBe("github");
  });
});

describe("credential injection", () => {
  const raw = '{"id":9,"method":"Input.insertText","params":{"text":"{{vault:web/github}}"}}';

  it("injects the real value on a bound origin, verbatim", () => {
    const outcome = applyFill(raw, "github", "https://github.com", CREDS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The value survives untouched, quotes and backslashes included.
    expect(JSON.parse(outcome.frame).params.text).toBe(CREDS.credentials.github.value);
  });

  it("covers subdomains of a bound domain", () => {
    expect(applyFill(raw, "github", "https://gist.github.com", CREDS).ok).toBe(true);
  });

  it("refuses an unbound origin (the phishing case)", () => {
    const outcome = applyFill(raw, "github", "https://github-login.evil.com", CREDS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("origin_unbound");
    expect(JSON.parse(outcome.response).error.message).toContain("not bound");
  });

  it("refuses an unresolved origin rather than defaulting", () => {
    expect(applyFill(raw, "github", "", CREDS).ok).toBe(false);
  });

  it("substitutes a callFunctionOn ARGUMENT, never the function body", () => {
    const call = JSON.stringify({
      id: 3,
      method: "Runtime.callFunctionOn",
      params: {
        objectId: "obj-1",
        functionDeclaration: "function(v){ this.value = v }",
        arguments: [{ value: "{{vault:web/github}}" }]
      }
    });
    const outcome = applyFill(call, "github", "https://github.com", CREDS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const parsed = JSON.parse(outcome.frame);
    expect(parsed.params.arguments[0].value).toBe(CREDS.credentials.github.value);
    expect(parsed.params.functionDeclaration).toBe("function(v){ this.value = v }");
  });

  it("refuses to splice a credential into evaluate() source", () => {
    const evaluate = JSON.stringify({
      id: 4,
      method: "Runtime.evaluate",
      params: { expression: 'document.querySelector("#p").value = "{{vault:web/github}}"' }
    });
    const outcome = applyFill(evaluate, "github", "https://github.com", CREDS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("source_splice_refused");
    expect(JSON.parse(outcome.response).error.message).toContain("argument");
  });

  it("refuses to splice a credential into a function body", () => {
    const call = JSON.stringify({
      id: 5,
      method: "Runtime.callFunctionOn",
      params: { objectId: "o", functionDeclaration: 'function(){ this.value = "{{vault:web/github}}" }' }
    });
    expect(applyFill(call, "github", "https://github.com", CREDS).ok).toBe(false);
  });

  it("refuses a fill when focus is inside a subframe", () => {
    // The top page may be on a bound origin while focus sits in a
    // cross-origin iframe; filling there would leak the credential.
    const outcome = applyFill(raw, "github", "operon:focus-in-subframe", CREDS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("focus_in_subframe");
    expect(JSON.parse(outcome.response).error.message).toContain("objectId");
  });

  it("refuses an unknown credential name", () => {
    const outcome = applyFill(raw, "nope", "https://github.com", CREDS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("unknown_credential");
  });
});

describe("response redaction", () => {
  it("redacts a minted password read back out of the page", () => {
    // The fill put the real value INTO the page; an ordinary evaluate
    // reading input.value must not hand it to the mind.
    const response = JSON.stringify({
      id: 12,
      result: { result: { type: "string", value: CREDS.credentials.github.value } }
    });
    const { frame, redacted } = redactCredentials(response, CREDS);
    expect(redacted).toEqual(["github"]);
    expect(frame).not.toContain(CREDS.credentials.github.value);
    expect(frame).toContain("{{vault:web/github}}");
  });

  it("leaves ordinary frames untouched", () => {
    const response = '{"id":3,"result":{"result":{"value":"hello"}}}';
    const { frame, redacted } = redactCredentials(response, CREDS);
    expect(frame).toBe(response);
    expect(redacted).toEqual([]);
  });

  it("is a no-op when the session holds no credentials", () => {
    const response = '{"id":3,"result":{}}';
    expect(redactCredentials(response, {}).frame).toBe(response);
  });
});

describe("matchers", () => {
  it("matches hosts exactly and by wildcard suffix", () => {
    expect(hostMatches("evil.example", "evil.example")).toBe(true);
    expect(hostMatches("a.tracker.net", "*.tracker.net")).toBe(true);
    expect(hostMatches("tracker.net", "*.tracker.net")).toBe(true);
    expect(hostMatches("nottracker.net", "*.tracker.net")).toBe(false);
  });

  it("binds an origin to a domain and its subdomains only", () => {
    expect(originOnDomain("https://github.com", ["github.com"])).toBe(true);
    expect(originOnDomain("https://auth.github.com", ["github.com"])).toBe(true);
    expect(originOnDomain("https://github.com.evil.net", ["github.com"])).toBe(false);
    expect(originOnDomain("not a url", ["github.com"])).toBe(false);
  });
});
