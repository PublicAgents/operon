import { describe, expect, it } from "vitest";
import { cdpDecision } from "./cdp-policy.js";

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

  it("blocks Storage.getCookies and getStorageKeyForFrame", () => {
    expect(cdpDecision('{"id":1,"method":"Storage.getCookies"}').action).toBe("block");
    expect(cdpDecision('{"id":2,"method":"Storage.getStorageKeyForFrame"}').action).toBe("block");
  });

  it("forwards ordinary automation methods", () => {
    expect(cdpDecision('{"id":1,"method":"Page.navigate","params":{"url":"https://x"}}').action).toBe("forward");
    expect(cdpDecision('{"id":2,"method":"Input.insertText","params":{"text":"hi"}}').action).toBe("forward");
    expect(cdpDecision('{"id":3,"method":"Runtime.evaluate"}').action).toBe("forward");
  });

  it("forwards non-command frames untouched", () => {
    expect(cdpDecision("not json").action).toBe("forward");
    expect(cdpDecision('{"id":5,"result":{}}').action).toBe("forward");
    expect(cdpDecision("").action).toBe("forward");
  });
});
